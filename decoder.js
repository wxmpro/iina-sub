const { utils, file, console } = iina;

const srt = require("./srt.js");

/**
 * The audio decoder.
 *
 * The speech recognition model reads 16 kHz mono PCM. A video file keeps its
 * audio in a compressed format inside a container, so it has to be decoded
 * first.
 *
 * macOS ships with everything that is needed for that: AVFoundation reads the
 * audio track of a video file and can hand it over as plain PCM. A small
 * helper program built on top of it does the job, so the plugin needs no
 * external decoder and no external process beyond the model itself.
 *
 * The helper is compiled once and then kept in the plugin folder. When no
 * Swift compiler is available the source is run with the interpreter
 * instead, which produces exactly the same output.
 */

/**
 * The helper source.
 *
 * It is embedded here so that the plugin stays a plain set of scripts. The
 * same source is kept as `tools/vina.swift` in the repository for reading.
 *
 * `String.raw` keeps the escape sequences of the Swift source untouched.
 */
const SWIFT_SOURCE = String.raw`import AVFoundation
import Foundation

// vina — Video INto Audio
//
// Decodes the audio track of a video file and writes it as 16 kHz mono signed
// 16 bit PCM inside a WAV container. That is the only format the speech
// recognition model accepts.
//
// It replaces ffmpeg with the media framework that macOS ships with, so the
// plugin needs no external decoder.
//
// Usage: vina <media-file> [start-seconds] [duration-seconds] [audio-track]
//        vina --duration <media-file>
//        vina --wav <output-file> <media-file> [start] [duration] [audio-track]

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(("vina: " + message + "\n").data(using: .utf8)!)
    exit(1)
}

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    fail("usage: vina <media-file> [start-seconds] [duration-seconds] [audio-track]")
}

// The length of the file is asked for on its own. The metadata tool of the
// system only knows the length of the files that its search index knows, so
// this is the way to find the length of a file that nobody has indexed.
if arguments[1] == "--duration" {
    guard arguments.count >= 3 else {
        fail("usage: vina --duration <media-file>")
    }
    // Reading the length of a file is a matter of a moment. A file that
    // keeps the media framework busy must not hold the plugin up.
    DispatchQueue.global().asyncAfter(deadline: .now() + 60) {
        FileHandle.standardError.write("vina: reading the length took too long\n".data(using: .utf8)!)
        exit(5)
    }
    let url = URL(fileURLWithPath: arguments[2])
    let done = DispatchSemaphore(value: 0)
    Task {
        let asset = AVURLAsset(url: url)
        do {
            let duration = try await asset.load(.duration)
            let seconds = CMTimeGetSeconds(duration)
            guard seconds.isFinite, seconds > 0 else {
                fail("the file has no length")
            }
            print(String(format: "%.3f", seconds))
        } catch {
            fail(error.localizedDescription)
        }
        done.signal()
    }
    done.wait()
    exit(0)
}

// The audio goes to standard output unless the caller names a file. The
// engines that read a file instead of a stream need a file.
var outputPath: String? = nil
var mediaArgument = arguments[1]
var startArgument: String? = nil
var durationArgument: String? = nil
var trackArgument: String? = nil

if arguments[1] == "--wav" {
    guard arguments.count >= 4 else {
        fail("usage: vina --wav <output-file> <media-file> [start-seconds] [duration-seconds] [audio-track]")
    }
    outputPath = arguments[2]
    mediaArgument = arguments[3]
    startArgument = arguments.count > 4 ? arguments[4] : nil
    durationArgument = arguments.count > 5 ? arguments[5] : nil
    trackArgument = arguments.count > 6 ? arguments[6] : nil
} else {
    startArgument = arguments.count > 2 ? arguments[2] : nil
    durationArgument = arguments.count > 3 ? arguments[3] : nil
    trackArgument = arguments.count > 4 ? arguments[4] : nil
}

let mediaURL = URL(fileURLWithPath: mediaArgument)
let startSeconds = startArgument.flatMap { Double($0) } ?? 0
let durationSeconds = durationArgument.flatMap { Double($0) } ?? 0
let trackIndex = trackArgument.flatMap { Int($0) } ?? 0

/// Write a WAV header for a stream whose total length is not known yet.
/// The size fields are left at 0xFFFFFFFF, which is what streaming writers do
/// and what every WAV reader accepts.
func wavHeader() -> Data {
    var header = Data()
    let sampleRate: UInt32 = 16000
    let channels: UInt16 = 1
    let bitsPerSample: UInt16 = 16
    let byteRate = sampleRate * UInt32(channels) * UInt32(bitsPerSample / 8)
    let blockAlign = channels * UInt16(bitsPerSample / 8)

    func append(_ value: UInt32) { withUnsafeBytes(of: value.littleEndian) { header.append(contentsOf: $0) } }
    func append(_ value: UInt16) { withUnsafeBytes(of: value.littleEndian) { header.append(contentsOf: $0) } }
    func append(_ text: String) { header.append(contentsOf: Array(text.utf8)) }

    append("RIFF")
    append(UInt32(0xFFFFFFFF))
    append("WAVE")
    append("fmt ")
    append(UInt32(16))
    append(UInt16(1)) // PCM
    append(channels)
    append(sampleRate)
    append(byteRate)
    append(blockAlign)
    append(bitsPerSample)
    append("data")
    append(UInt32(0xFFFFFFFF))
    return header
}

// The file the audio is written to. It is standard output unless a file was
// named on the command line.
let outputHandle: FileHandle
let closesOutput: Bool

if let path = outputPath {
    let url = URL(fileURLWithPath: path)
    // A file that is already there would be appended to, so it is removed
    // first. The name is the one the plugin chose, so nothing else can be
    // touched by this.
    if FileManager.default.fileExists(atPath: path) {
        try? FileManager.default.removeItem(at: url)
    }
    guard FileManager.default.createFile(atPath: path, contents: nil) else {
        fail("the output file could not be created: " + path)
    }
    guard let handle = FileHandle(forWritingAtPath: path) else {
        fail("the output file could not be opened: " + path)
    }
    outputHandle = handle
    closesOutput = true
} else {
    outputHandle = FileHandle.standardOutput
    closesOutput = false
}

let done = DispatchSemaphore(value: 0)

// The helper never waits for ever. A file that the media framework cannot
// make sense of can keep it busy, and the plugin would wait with it.
DispatchQueue.global().asyncAfter(deadline: .now() + 300) {
    FileHandle.standardError.write("vina: the decoding took too long\n".data(using: .utf8)!)
    exit(5)
}

// The exit code tells the caller what happened.
//   0  the audio was written
//   3  the requested part of the file holds no sound at all
//   4  the requested part of the file is silent
var sampleCount: UInt64 = 0
var peakValue: Int = 0

Task {
    let asset = AVURLAsset(url: mediaURL)

    do {
        let tracks = try await asset.loadTracks(withMediaType: .audio)
        guard !tracks.isEmpty else {
            fail("the file has no audio track")
        }
        // The player tells us which audio track the user is listening to.
        let track = tracks[min(max(trackIndex, 0), tracks.count - 1)]

        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(
            track: track,
            outputSettings: [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVSampleRateKey: 16000,
                AVNumberOfChannelsKey: 1,
                AVLinearPCMBitDepthKey: 16,
                AVLinearPCMIsBigEndianKey: false,
                AVLinearPCMIsFloatKey: false,
                AVLinearPCMIsNonInterleaved: false,
            ]
        )
        output.alwaysCopiesSampleData = false

        if durationSeconds > 0 {
            let start = CMTime(seconds: startSeconds, preferredTimescale: 600)
            let length = CMTime(seconds: durationSeconds, preferredTimescale: 600)
            reader.timeRange = CMTimeRange(start: start, duration: length)
        } else if startSeconds > 0 {
            let start = CMTime(seconds: startSeconds, preferredTimescale: 600)
            reader.timeRange = CMTimeRange(start: start, duration: CMTime(seconds: 3600 * 6, preferredTimescale: 600))
        }

        reader.add(output)

        outputHandle.write(wavHeader())

        if reader.startReading() {
            while let sample = output.copyNextSampleBuffer() {
                guard let block = CMSampleBufferGetDataBuffer(sample) else { continue }
                let length = CMBlockBufferGetDataLength(block)
                if length <= 0 { continue }
                var bytes = Data(count: length)
                bytes.withUnsafeMutableBytes { destination in
                    if let base = destination.baseAddress {
                        CMBlockBufferCopyDataBytes(
                            block,
                            atOffset: 0,
                            dataLength: length,
                            destination: base
                        )
                    }
                }
                // The loudest sample of the part is looked at, so that a
                // part that holds nothing but silence can be told apart
                // from a part that holds speech.
                sampleCount += UInt64(bytes.count) / 2
                bytes.withUnsafeBytes { raw in
                    let samples = raw.bindMemory(to: Int16.self)
                    for index in 0..<samples.count {
                        let value = Int(samples[index])
                        if value < 0 { peakValue = max(peakValue, -value) } else { peakValue = max(peakValue, value) }
                    }
                }

                outputHandle.write(bytes)
            }

            if reader.status == .failed {
                fail(reader.error?.localizedDescription ?? "the audio could not be decoded")
            }
        } else {
            fail(reader.error?.localizedDescription ?? "the reader could not start")
        }
    } catch {
        fail(error.localizedDescription)
    }

    if closesOutput {
        try? outputHandle.close()
    }

    // A part of the file that holds no sound is not an error: the caller
    // simply has nothing to recognise there. The exit code says so.
    if sampleCount == 0 {
        FileHandle.standardError.write("vina: the requested part of the file holds no sound\n".data(using: .utf8)!)
        exit(3)
    }
    // A part that is quieter than this holds nothing but the noise of the
    // room. The speech model would make something up out of it, so it is
    // better to say that there is nothing to hear.
    if peakValue < 32 {
        FileHandle.standardError.write("vina: the requested part of the file is silent\n".data(using: .utf8)!)
        exit(4)
    }

    done.signal()
}

done.wait()
`;

/**
 * Where the source of the helper is written.
 */
function sourcePath() {
  return utils.resolvePath("@data/vina.swift");
}

/**
 * Where the compiled helper is kept.
 *
 * The name carries a fingerprint of the source, so a new version of the
 * plugin builds a new helper instead of quietly using the old one.
 */
function binaryPath() {
  return utils.resolvePath("@data/bin/vina-" + srt.sha256(SWIFT_SOURCE).slice(0, 16));
}

/**
 * Make sure the helper is ready and return the command that runs it.
 *
 * The command is either the compiled binary or, when no compiler is
 * available, the Swift interpreter running the source directly. Both produce
 * the same output.
 *
 * Only one build runs at a time. Two of them would write to the same place,
 * and the result of a race would be a helper that is half written.
 */
async function ensureDecoder() {
  if (pending) return pending;
  pending = buildDecoder();
  try {
    return await pending;
  } finally {
    pending = null;
  }
}

/**
 * The build that is running at the moment, if there is one.
 */
let pending = null;

async function buildDecoder() {
  const binary = binaryPath();
  if (binary && utils.fileInPath(binary)) {
    return { command: binary, args: [], compiled: true };
  }

  const source = sourcePath();
  if (!source) {
    throw new Error("The plugin folder could not be resolved.");
  }

  // Write the source out so it can be compiled or interpreted.
  let alreadyWritten = false;
  try {
    if (file.exists(source)) {
      const existing = file.read(source, {});
      alreadyWritten = existing === SWIFT_SOURCE;
    }
  } catch (e) {
    alreadyWritten = false;
  }
  if (!alreadyWritten) {
    file.write(source, SWIFT_SOURCE);
  }

  // Try to compile it once.
  const swiftc = "/usr/bin/swiftc";
  if (utils.fileInPath(swiftc)) {
    const binDir = utils.resolvePath("@data/bin");
    if (binDir) {
      await utils.exec("/bin/mkdir", ["-p", binDir]);
    }
    // The helper is built under another name and put into place at the very
    // end. A build that is cut short would leave a helper that is half
    // written, and its name carries the fingerprint of the source, so it
    // would be used for ever.
    const temporary = binary + ".building";
    const res = await utils.exec(swiftc, ["-O", source, "-o", temporary]);
    if (res.status === 0 && temporary && utils.fileInPath(temporary)) {
      const move = await utils.exec("/bin/mv", ["-f", temporary, binary]);
      if (move.status === 0 && binary && utils.fileInPath(binary)) {
        return { command: binary, args: [], compiled: true };
      }
    }
    try {
      await utils.exec("/bin/rm", ["-f", temporary]);
    } catch (e) {
      /* best effort */
    }
    console.warn("iina-sub: could not compile the decoder: " + (res.stderr || ""));
  }

  // Fall back to running the source with the Swift interpreter.
  const swift = "/usr/bin/swift";
  if (utils.fileInPath(swift)) {
    return { command: swift, args: [source], compiled: false };
  }

  throw new Error(
    "No Swift compiler is available, so the audio decoder cannot be built. " +
      "Install the Xcode command line tools with `xcode-select --install`."
  );
}

/**
 * Build the helper in the background, so that the first transcription does
 * not have to wait for it.
 */
function prepareDecoder() {
  return ensureDecoder().catch((e) => {
    console.warn("iina-sub: the audio decoder is not ready: " + e);
    return null;
  });
}

/**
 * The length of a media file in milliseconds.
 *
 * The metadata tool of the system only knows the length of the files that
 * its search index knows about. Files in a temporary folder, on a disk that
 * is not indexed or on a network volume are unknown to it, so the decoder is
 * asked instead.
 */
async function durationOf(mediaPath) {
  if (!mediaPath) return 0;
  try {
    const helper = await ensureDecoder();
    const res = await utils.exec(
      helper.command,
      helper.args.concat(["--duration", mediaPath])
    );
    if (res.status !== 0) return 0;
    const seconds = parseFloat(String(res.stdout || "").trim());
    if (!isFinite(seconds) || seconds <= 0) return 0;
    return Math.round(seconds * 1000);
  } catch (e) {
    console.warn("iina-sub: could not read the length of " + mediaPath + ": " + e);
    return 0;
  }
}

/**
 * Write the audio of one part of a media file into a WAV file.
 *
 * The file holds the part and nothing else, so the times an engine reports
 * belong to the part and to nothing else.
 *
 * The result says whether the part holds any sound. A part that is silent
 * is not an error: the speech model would only make something up out of it,
 * so the caller is told to leave it alone.
 */
async function writeWav(outputPath, mediaPath, startSeconds, durationSeconds, trackIndex) {
  if (!outputPath || !mediaPath) {
    throw new Error("The decoder needs a file to write and a file to read.");
  }
  const helper = await ensureDecoder();
  const res = await utils.exec(
    helper.command,
    helper.args.concat([
      "--wav",
      outputPath,
      mediaPath,
      String(startSeconds || 0),
      String(durationSeconds || 0),
      String(typeof trackIndex === "number" && trackIndex >= 0 ? trackIndex : 0),
    ])
  );

  // Exit code 3 means that the part holds no sound at all, exit code 4
  // that it is quieter than a whisper.
  if (res.status === 3 || res.status === 4) {
    return { path: outputPath, silent: true, message: (res.stderr || "").trim() };
  }
  if (res.status !== 0) {
    throw new Error(
      "The audio could not be decoded: " + (res.stderr || "").trim()
    );
  }
  return { path: outputPath, silent: false, message: "" };
}

module.exports = {
  ensureDecoder,
  prepareDecoder,
  durationOf,
  writeWav,
  sourcePath,
  binaryPath,
  SWIFT_SOURCE,
};
