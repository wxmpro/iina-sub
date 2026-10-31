import AVFoundation
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
