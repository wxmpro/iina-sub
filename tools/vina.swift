import AVFoundation
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
