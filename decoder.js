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
// Decodes the audio track of a video file and writes it to standard output as
// 16 kHz mono signed 16 bit PCM inside a WAV container. That is the only
// format the speech recognition model accepts.
//
// It replaces ffmpeg with the media framework that macOS ships with, so the
// plugin needs no external decoder.
//
// Usage: vina <media-file> [start-seconds] [duration-seconds] [audio-track]
//        vina --duration <media-file>

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

let mediaURL = URL(fileURLWithPath: arguments[1])
let startSeconds = arguments.count > 2 ? (Double(arguments[2]) ?? 0) : 0
let durationSeconds = arguments.count > 3 ? (Double(arguments[3]) ?? 0) : 0
let trackIndex = arguments.count > 4 ? Int(arguments[4]) ?? 0 : 0

/// Write a WAV header for a stream whose total length is not known yet.
/// The size fields are left at 0xFFFFFFFF, which is what streaming writers do
/// and what every WAV reader accepts.
func wavHeader() -> Data {
    var header = Data()
    let sampleRate: UInt32 = 16000
    let channels: UInt16 = 1
    let bitsPerSample: UInt16 = 16
    let byteRate = sampleRate * UInt32(channels) * UInt32(bitsPerSample / 8)
    let blockAlign = channels * (bitsPerSample / 8)

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

let done = DispatchSemaphore(value: 0)

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

        FileHandle.standardOutput.write(wavHeader())

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
                FileHandle.standardOutput.write(bytes)
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
  return utils.resolvePath("@data/bin/vina-" + srt.fnv1a(SWIFT_SOURCE));
}

/**
 * Make sure the helper is ready and return the command that runs it.
 *
 * The command is either the compiled binary or, when no compiler is
 * available, the Swift interpreter running the source directly. Both produce
 * the same output.
 */
async function ensureDecoder() {
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
    const res = await utils.exec(swiftc, ["-O", source, "-o", binary]);
    if (res.status === 0 && binary && utils.fileInPath(binary)) {
      return { command: binary, args: [], compiled: true };
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

module.exports = {
  ensureDecoder,
  prepareDecoder,
  durationOf,
  sourcePath,
  binaryPath,
  SWIFT_SOURCE,
};
