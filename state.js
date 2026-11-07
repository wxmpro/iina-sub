const { console } = iina;

/**
 * The state of the plugin, in one place.
 *
 * Every part of the plugin reads and writes this object and nothing else, so
 * that there is one answer to the question "what is going on at the moment".
 * The parts that used to keep their own variables — the running job, the
 * loaded subtitle, the flags of the first run — live here together.
 *
 * The object is kept on the global object of the player. The player builds a
 * module again for every request of it, so this module can end up being
 * built more than once; the object on the global object is the same one
 * every time, and there is therefore still only one state.
 */
const KEY = "__iinaSubState";

function freshState() {
  return {
    /** The transcription that is currently running, if any. */
    job: null,

    /** Path of the subtitle file that is currently loaded into the player. */
    subtitlePath: null,

    /** The number of that subtitle track, so that it can be reloaded by name. */
    subtitleId: null,

    /** Whether a batch of files is being transcribed. */
    batchRunning: false,

    /** The files of the batch that are still to be done. */
    batchQueue: [],

    /**
     * The files that are waiting for the running transcription to finish.
     *
     * A file that is opened while another one is being transcribed does not
     * have to wait for ever: it is put aside here and started as soon as the
     * running one is done. Without this, opening a second video while the
     * first one is still running would leave the second one without
     * subtitles, and nothing would start it later.
     *
     * It is a list and not a single entry: the player can open several files
     * in a row (it puts the rest of a folder into the playlist), and every
     * one of them wants subtitles.
     */
    pending: [],

    /** The small log that the sidebar shows. */
    activityLog: [],

    /** Whether the first run already asked about the program. */
    engineOfferMade: false,

    /** Whether the first run already asked about the model. */
    modelOfferMade: false,
  };
}

const globalObject = typeof globalThis !== "undefined" ? globalThis : null;
if (globalObject && !globalObject[KEY]) {
  globalObject[KEY] = freshState();
}
const state = globalObject && globalObject[KEY] ? globalObject[KEY] : freshState();


/**
 * Whether a transcription is running or about to run.
 */
function isBusy() {
  return state.job !== null;
}

/**
 * The audio track a transcription uses, counted among the audio tracks.
 *
 * A track that cannot be told apart from the others is the first one, which
 * is what the decoder falls back to as well.
 */
function effectiveTrackIndex(raw) {
  return typeof raw === "number" && raw >= 0 ? raw : 0;
}

module.exports = { state, isBusy, effectiveTrackIndex };
