import AVFoundation
import Foundation

// trim — cut a part out of a video file
//
// It is a development helper for the test suite: it makes a short clip out
// of a long recording so that the whole pipeline can be exercised in a
// reasonable amount of time.
//
// The media is copied as it is, so both the picture and the sound of the
// result are exactly the ones of the source.
//
// Usage: trim <source> <target> <start-seconds> <duration-seconds>

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(("trim: " + message + "\n").data(using: .utf8)!)
    exit(1)
}

let arguments = CommandLine.arguments
guard arguments.count >= 5 else {
    fail("usage: trim <source> <target> <start-seconds> <duration-seconds>")
}

let sourceURL = URL(fileURLWithPath: arguments[1])
let targetURL = URL(fileURLWithPath: arguments[2])
let startSeconds = Double(arguments[3]) ?? 0
let durationSeconds = Double(arguments[4]) ?? 0

try? FileManager.default.removeItem(at: targetURL)

let group = DispatchGroup()
group.enter()

Task {
    defer { group.leave() }

    let asset = AVURLAsset(url: sourceURL)
    do {
        let range = CMTimeRange(
            start: CMTime(seconds: startSeconds, preferredTimescale: 600),
            duration: CMTime(seconds: durationSeconds, preferredTimescale: 600)
        )

        guard let export = AVAssetExportSession(
            asset: asset, presetName: AVAssetExportPresetPassthrough
        ) else {
            fail("the export session could not be created")
        }
        export.timeRange = range
        export.shouldOptimizeForNetworkUse = true

        if #available(macOS 15.0, *) {
            try await export.export(to: targetURL, as: .mp4)
        } else {
            export.outputURL = targetURL
            export.outputFileType = .mp4
            await export.export()
            guard export.status == .completed else {
                fail(export.error?.localizedDescription ?? "the export failed")
            }
        }

        print("trim: wrote " + targetURL.path)
    } catch {
        fail(error.localizedDescription)
    }
}

group.wait()
