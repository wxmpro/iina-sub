const { core, mpv, utils, file, console } = iina;

const { state, isBusy, effectiveTrackIndex } = require("./state.js");
const ui = require("./ui.js");
const config = require("./config.js");
const player = require("./player.js");
const cache = require("./cache.js");
const srt = require("./srt.js");
const worker = require("./worker.js");
const engines = require("./engines.js");
const decoder = require("./decoder.js");
const models = require("./models.js");
const script = require("./script.js");


/**
 * Pick the chunk that matters most for the viewer.
 *
 * Three rules, in this order:
 *
 *  - the part of the file the viewer is watching comes first, so that the text
 *    of the moment is there as soon as it can be;
 *  - when the viewer has jumped far ahead of what has been transcribed, the
 *    file is worked on from two sides at once: the part in front of the
 *    playhead is filled in, and the part behind it is filled in as well. The
 *    viewer who keeps watching past the point they jumped to does not have
 *    to wait for the whole part in front of it;
 *  - otherwise the file is transcribed from its beginning, so that the
 *    transcript is always one continuous stretch from the start of the file.
 *
 * A chunk that has been done is named by its start, not by its number: the
 * plan is cut again while the run goes on, and a number would then point at
 * another piece of audio than before.
 */
function pickNextChunk(chunks, done, positionMs) {
  if (!chunks || chunks.length === 0) return null;

  // The first chunk that has not been transcribed, counting from the
  // beginning of the file. Everything before it is done, so the transcript
  // reaches this far without a gap.
  let firstMissing = 0;
  while (firstMissing < chunks.length && done.has(chunks[firstMissing].startMs)) {
    firstMissing++;
  }
  const prefix = firstMissing < chunks.length ? chunks[firstMissing] : null;

  // The chunk the playhead is in.
  let current = null;
  for (const chunk of chunks) {
    if (positionMs >= chunk.startMs && positionMs < chunk.startMs + chunk.lengthMs) {
      current = chunk;
      break;
    }
  }

  // The playhead is in a part of the file that is not covered yet. That part
  // is done first, so that the viewer does not wait for text of the moment.
  if (current && !done.has(current.startMs)) return current;

  // The first chunk behind the playhead that is not transcribed yet. It is
  // what the viewer will reach next, so it is worth having soon.
  let ahead = null;
  for (const chunk of chunks) {
    if (chunk.startMs <= positionMs) continue;
    if (done.has(chunk.startMs)) continue;
    ahead = chunk;
    break;
  }

  // The playhead is far beyond what has been transcribed. The two parts are
  // worked on in turn, so that neither has to wait for the other.
  const coveredUntilMs = prefix ? prefix.startMs + prefix.lengthMs : 0;
  if (ahead && prefix && positionMs > coveredUntilMs + 60000) {
    // The two parts take turns. The count of the chunks that are done says
    // which of the two it is.
    return done.size % 2 === 1 ? ahead : prefix;
  }

  // Otherwise the file is filled from the front, so that the transcript stays
  // continuous.
  if (prefix) return prefix;
  return ahead;
}

/**
 * Write the current cues to disk and refresh the player.
 *
 * The transcript lives inside the plugin folder, where the file API of the
 * player is allowed to overwrite a file that is already there.
 *
 * Only the transcript is written here. The mark that tells the plugin that
 * the transcript is complete is written when the whole file was
 * transcribed, so that a half finished transcript is never taken for a
 * finished one.
 */
async function publishCues(job) {
  const paths = job.paths;
  const content = srt.renderSrt(job.cues);
  try {
    file.write(paths.subtitle, content);
  } catch (e) {
    // A disk that is full shows up here. The run goes on, but the result
    // cannot be trusted, so it is not marked as complete.
    console.error("iina-sub: could not write the transcript: " + e);
    job.writeFailed = true;
    return;
  }
  showTranscript(job);
}

/**
 * Put the transcript on the screen.
 *
 * The file in the plugin folder is the one that follows the transcription.
 * When the player shows the exported copy instead — a snapshot that was
 * written next to the video earlier — the file in the plugin folder is added
 * and selected, so that the screen shows the current state again.
 */
function showTranscript(job) {
  // The viewer has moved on to another file. The subtitles of this one
  // belong to a video that is not on the screen any more, so the player is
  // left alone.
  if (job.mediaPath !== player.currentMediaPath()) return;

  const internal = job.paths.subtitle;
  const exported = srt.subtitlePathFor(job.mediaPath);

  if (state.subtitlePath === internal) {
    player.reloadSubtitle();
    return;
  }

  if (state.subtitlePath && exported && state.subtitlePath === exported) {
    // The copy next to the video is a snapshot of an earlier run.
    player.loadSubtitle(internal);
    return;
  }

  player.loadSubtitle(internal, exported ? [exported] : []);
}

/**
 * Run a transcription job for one media file.
 */
async function runJob(job) {
  const { config: settings, engine } = job;

  // The audio of earlier runs is removed before this one starts. A run that
  // was stopped half way leaves the audio of the part it had reached, and
  // that audio is the voice of the user in plain text.
  await worker.clearChunkDirectory();

  let chunks = worker.planChunks(
    job.durationMs,
    settings.chunkSeconds,
    settings.tailSeconds,
    settings.firstChunkSeconds
  );
  if (chunks.length === 0) {
    throw new Error("The duration of this file is unknown, so it cannot be split into chunks.");
  }

  const done = new Set();
  const startedAt = Date.now();
  const failures = [];
  let attempted = 0;

  try {
    while (done.size < chunks.length) {
      if (job.cancelled) break;

      // The playhead may sit in a chunk that is long and not transcribed
      // yet. It is cut here, at every turn, so that a drag in the middle of
      // the run gets the same quick text as the start of the file.
      const positionMs = job.positionMs ? job.positionMs() : 0;
      chunks = worker.splitChunkAtPlayhead(
        chunks,
        positionMs,
        settings.firstChunkSeconds,
        settings.tailSeconds,
        done
      );

      const chunk = pickNextChunk(chunks, done, positionMs);
      if (!chunk) break;
      done.add(chunk.startMs);
      attempted++;

      const base = ((done.size - 1) / chunks.length) * 100;
      const span = 100 / chunks.length;
      const ordinal = chunks.indexOf(chunk) + 1;

      let cues = null;
      try {
        cues = await worker.transcribeChunk(
          job.context,
          engine,
          chunk,
          (percent) => {
            ui.pushStatus(
              {
                phase: "transcribing",
                message: "Transcribing",
                detail: "Chunk {0} / {1}",
                percent: base + span * (percent / 100),
                video: job.mediaPath,
                elapsed: (Date.now() - startedAt) / 1000,
              },
              ordinal,
              chunks.length
            );
          }
        );
      } catch (e) {
        const message = e && e.message ? e.message : String(e);
        // A chunk that fails costs that chunk and not the whole run. The
        // very first one is the exception: when it fails, the problem is
        // the setup and not the file, and running the rest would only
        // produce the same error over and over.
        if (attempted === 1) throw new Error(message);
        failures.push(message);
        console.warn("iina-sub: chunk at " + chunk.startMs + " failed: " + message);
        ui.pushStatus(
          {
            phase: "transcribing",
            message: "Transcribing",
            detail: "Chunk {0} / {1} failed",
            percent: (done.size / chunks.length) * 100,
            video: job.mediaPath,
            elapsed: (Date.now() - startedAt) / 1000,
          },
          ordinal,
          chunks.length
        );
        continue;
      }

      if (job.cancelled) break;

      // What the model wrote is brought into the script that was asked for.
      // The model was told which script to write in, so this changes
      // nothing for the engines that listen; it is the fallback for the
      // ones that do not, and for the few characters the model got wrong.
      script.applyToCues(cues, settings);

      // The program is too old to be told which script to write in. The
      // user is told about it, because the model writes the script by
      // itself as long as the program is not updated.
      if (!job.oldEngineWarned && engines.promptSupport() === "no") {
        job.oldEngineWarned = true;
        ui.osd("the speech recognition program is too old, please update it");
        ui.logActivity(
          "The speech recognition program does not know the option that tells it " +
            "which script to write in. Update it (brew upgrade whisper.cpp, or " +
            "pip install -U mlx-whisper) and the model will write in the script " +
            "you chose; until then the text is brought over afterwards."
        );
      }

      srt.mergeCues(job.cues, cues, 0);
      await publishCues(job);

      ui.pushStatus(
        {
          phase: "transcribing",
          message: "Transcribing",
          detail: "Chunk {0} / {1}",
          percent: (done.size / chunks.length) * 100,
          video: job.mediaPath,
          elapsed: (Date.now() - startedAt) / 1000,
        },
        ordinal,
        chunks.length
      );
    }

    if (job.cancelled) {
      ui.pushStatus({
        phase: "cancelled",
        message: "Cancelled",
        detail: job.mediaPath,
        video: job.mediaPath,
        elapsed: (Date.now() - startedAt) / 1000,
      });
      ui.osd("transcription cancelled");
      return false;
    }

    if (job.writeFailed) {
      const message = "The transcript could not be written. The disk may be full.";
      console.error("iina-sub: " + message);
      ui.pushStatus({
        phase: "error",
        message: "Failed",
        detail: message,
        video: job.mediaPath,
        elapsed: (Date.now() - startedAt) / 1000,
      });
      ui.osd(message);
      ui.logActivity("Failed: {0} — {1}", ui.baseName(job.mediaPath), message);
      return false;
    }

    // The mark that says the transcript is complete is written only now. A
    // transcript that is missing a part is not a valid cache, so the file
    // is transcribed again the next time it is opened.
    if (failures.length === 0) {
      try {
        file.write(job.paths.stamp, job.fingerprint);
      } catch (e) {
        console.error("iina-sub: could not write the mark of the transcript: " + e);
      }
    }

    ui.pushStatus({
      phase: failures.length === 0 ? "done" : "partial",
      message: failures.length === 0 ? "Done" : "Done with gaps",
      detail:
        failures.length === 0
          ? job.paths.subtitle
          : failures.length + " of " + chunks.length + " chunks failed",
      percent: 100,
      video: job.mediaPath,
      elapsed: (Date.now() - startedAt) / 1000,
    });
    if (failures.length === 0) {
      ui.osd("subtitles ready");
    } else {
      ui.osd("subtitles ready, but {0} chunks failed", failures.length);
    }
    ui.logActivity("Transcribed {0}", ui.baseName(job.mediaPath));
    return true;
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    console.error("iina-sub: " + message);
    ui.pushStatus({
      phase: "error",
      message: "Failed",
      detail: ui.shortMessage(message),
      video: job.mediaPath,
      elapsed: (Date.now() - startedAt) / 1000,
    });
    ui.osd(ui.shortMessage(message));
    ui.logActivity("Failed: {0} — {1}", ui.baseName(job.mediaPath), ui.shortMessage(message));
    return false;
  } finally {
    if (state.job === job) state.job = null;
    // A file that was opened while this one was being transcribed waits for
    // this moment. It is started now, so that it does not stay without
    // subtitles for ever.
    if (state.pending.length > 0 && !state.batchRunning) {
      runPending().catch((e) => {
        console.error("iina-sub: the queued transcription failed: " + e);
      });
    }
  }
}

/**
 * Start the transcription that was put aside while another one was running.
 */
async function runPending() {
  // The file that waits the longest comes first.
  const pending = state.pending.shift();
  if (!pending) return;

  // The file may have been transcribed while it was waiting.
  const cached = await cache.findValidCache(
    pending.mediaPath,
    pending.settings,
    pending.audioTrackIndex
  );
  if (cached && pending.settings.autoLoad) {
    player.loadSubtitle(cached.subtitle, [srt.subtitlePathFor(pending.mediaPath)]);
    ui.osd("loaded cached subtitles");
    // The next one starts right away.
    if (state.pending.length > 0) {
      await runPending();
    }
    return;
  }

  await startTranscription(pending.mediaPath, pending.durationMs, pending.silent);
}

/**
 * Build the job that transcribes one media file.
 *
 * The same shape is used for a single file and for a batch, so that the two
 * cannot drift apart. Nothing is waited for here, so that the job can be
 * put in place before the first wait.
 */
function createJob(mediaPath, durationMs, settings, engine, options) {
  const opts = options || {};
  const paths = cache.resolveCachePaths(mediaPath);
  if (!paths) return null;

  // A file that is not playing has no track of its own, so the first audio
  // track of the file is used.
  const audioTrackIndex =
    opts.audioTrackIndex === undefined ? player.currentAudioTrackIndex() : opts.audioTrackIndex;

  return {
    mediaPath: mediaPath,
    durationMs: durationMs,
    config: settings,
    engine: engine,
    paths: paths,
    cues: [],
    cancelled: false,
    writeFailed: false,
    oldEngineWarned: false,
    fingerprint: null,
    context: {
      config: settings,
      mediaPath: mediaPath,
      audioTrackIndex: audioTrackIndex,
      decoder: null,
    },
    positionMs:
      opts.positionMs ||
      function () {
        return 0;
      },
  };
}

/**
 * Fill in the parts of a job that have to wait.
 *
 * The decoder is built here, so that a machine without a compiler says so
 * right away and not in the middle of the first chunk.
 */
async function prepareJob(job) {
  job.fingerprint = await cache.buildFingerprint(
    job.mediaPath,
    job.config,
    effectiveTrackIndex(job.context.audioTrackIndex)
  );
  job.context.decoder = await decoder.ensureDecoder();

  // A model of the catalogue is looked at before it is used. The engine
  // loads such a file as a program, so a file that was changed on the way
  // is not used at all.
  if (job.engine && job.engine.requiresModel) {
    const check = await models.verifyModelFile(job.config.modelPath);
    if (!check.ok) {
      throw new Error("The model was not used. " + check.reason);
    }
  }
  return job;
}

/**
 * Start a transcription for a media file.
 */
async function startTranscription(mediaPath, durationMs, silent) {
  if (isBusy()) {
    ui.osd("a transcription is already running");
    return;
  }

  // The job is put in place before the first wait, so that a second request
  // cannot slip in while this one is still being set up. There is one lock
  // only, and it is this one.
  const job = createJob(mediaPath, durationMs, config.readConfig(), null, {
    positionMs: function () {
      if (mediaPath !== player.currentMediaPath()) return 0;
      return player.currentDurationMs() ? Number(mpv.getNumber("time-pos") || 0) * 1000 : 0;
    },
  });
  if (!job) return;
  state.job = job;

  try {
    await startTranscriptionNow(job, durationMs, silent);
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    console.error("iina-sub: " + message);
    ui.osd(ui.shortMessage(message));
    ui.pushStatus({ phase: "error", message: "Failed", detail: ui.shortMessage(message) });
    if (!silent) ui.ask(message);
    if (state.job === job) state.job = null;
  }
}

async function startTranscriptionNow(job, durationMs, silent) {
  const mediaPath = job.mediaPath;
  const settings = job.config;
  let engine;
  try {
    engine = config.validateConfig(settings);
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    ui.osd(message);
    ui.pushStatus({ phase: "error", message: "Failed", detail: message });
    // A run the user asked for deserves a dialog, one that started by itself
    // only deserves a note on the screen.
    if (!silent) ui.ask(message);
    if (state.job === job) state.job = null;
    return;
  }

  job.engine = engine;

  // The player may not know the length of the file yet, for example right
  // after it was opened. The length is then read from the file itself.
  if (!durationMs) {
    durationMs = await worker.durationOf(mediaPath, 0);
  }
  if (!durationMs) {
    const message =
      "The length of this file could not be read, so it cannot be transcribed.";
    ui.osd(message);
    ui.pushStatus({ phase: "error", message: "Failed", detail: message });
    if (!silent) ui.ask(message);
    if (state.job === job) state.job = null;
    return;
  }

  // The plugin writes the transcript and its fingerprint into folders of its
  // own data directory. They have to exist before the first write.
  await srt.ensureDir(utils.resolvePath("@data/subtitles"));
  await srt.ensureDir(utils.resolvePath("@data/fingerprints"));
  await srt.ensureDir(worker.chunkDirectory());

  job.durationMs = durationMs;
  await prepareJob(job);

  // A mark that is left over from an earlier run would say that a
  // transcript which is only half written is complete.
  try {
    if (file.exists(job.paths.stamp)) file.delete(job.paths.stamp);
  } catch (e) {
    /* ignore */
  }

  ui.osd("starting transcription");
  ui.pushStatus({
    phase: "starting",
    message: "Starting",
    detail: ui.baseName(mediaPath),
    percent: 0,
    video: mediaPath,
  });

  await runJob(job);
}

module.exports = {
  pickNextChunk,
  publishCues,
  showTranscript,
  runJob,
  runPending,
  createJob,
  prepareJob,
  startTranscription,
  startTranscriptionNow,
};
