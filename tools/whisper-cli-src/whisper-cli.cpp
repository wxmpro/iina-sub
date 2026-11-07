// whisper-cli for iina-sub.
//
// The speech recognition of whisper.cpp, with the smallest program that the
// plugin needs. It reads one WAV file, hands the samples to the library and
// writes the result as a SubRip file.
//
// The program is built against the library that the whisper.cpp project
// publishes with every release. The sources are written for this plugin, so
// that no file of the project has to be carried along.
//
// The license of whisper.cpp is MIT. See ../whisper.cpp-LICENSE.

#include "whisper.h"

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dirent.h>
#include <fstream>
#include <string>
#include <thread>
#include <unistd.h>
#include <vector>

// The library calls this to report how far it is. The plugin does not read
// it, so it is only written out when it is asked for.
static bool show_progress = false;

static void progress_callback(struct whisper_context *, struct whisper_state *, int progress, void *) {
    if (!show_progress) return;
    fprintf(stderr, "progress = %3d%%\n", progress);
}

/**
 * Read a WAV file into samples.
 *
 * Only the format that the decoder of the plugin writes is understood: one
 * channel, 16 bit signed, little endian. The sample rate is not checked,
 * because the library reads the rate from the file itself.
 *
 * Returns false when the file is not a WAV file of that shape.
 */
static bool read_wav(const std::string & path, std::vector<float> & samples) {
    std::ifstream file(path, std::ios::binary);
    if (!file) {
        fprintf(stderr, "error: the file could not be opened: %s\n", path.c_str());
        return false;
    }

    char header[12];
    file.read(header, 12);
    if (file.gcount() != 12 || memcmp(header, "RIFF", 4) != 0 || memcmp(header + 8, "WAVE", 4) != 0) {
        fprintf(stderr, "error: the file is not a WAV file: %s\n", path.c_str());
        return false;
    }

    int channels = 0;
    int bits = 0;
    bool haveFormat = false;

    // The pieces of the file are read one after the other until the samples
    // are found.
    while (true) {
        char chunk[8];
        file.read(chunk, 8);
        if (file.gcount() != 8) break;

        uint32_t size = 0;
        for (int i = 0; i < 4; i++) {
            size |= static_cast<uint32_t>(static_cast<unsigned char>(chunk[4 + i])) << (8 * i);
        }

        if (memcmp(chunk, "fmt ", 4) == 0) {
            std::vector<unsigned char> format(size < 16 ? 16 : size);
            file.read(reinterpret_cast<char *>(format.data()), format.size());
            if (size > 16) file.seekg(static_cast<std::streamoff>(size - 16), std::ios::cur);
            channels = format[2] | (format[3] << 8);
            bits = format[14] | (format[15] << 8);
            haveFormat = true;
            continue;
        }

        if (memcmp(chunk, "data", 4) == 0) {
            if (!haveFormat) {
                fprintf(stderr, "error: the WAV file has no format piece\n");
                return false;
            }
            if (channels != 1 || bits != 16) {
                fprintf(stderr,
                        "error: only one channel of 16 bit is understood, this file has %d channels of %d bit\n",
                        channels, bits);
                return false;
            }
            uint32_t count = size / 2;
            samples.resize(count);
            std::vector<int16_t> raw(count);
            file.read(reinterpret_cast<char *>(raw.data()), count * 2);
            size_t got = static_cast<size_t>(file.gcount()) / 2;
            samples.resize(got);
            // The samples are turned into the floats the library expects.
            for (size_t i = 0; i < got; i++) {
                samples[i] = static_cast<float>(raw[i]) / 32768.0f;
            }
            return true;
        }

        // Any other piece is stepped over.
        file.seekg(static_cast<std::streamoff>(size), std::ios::cur);
        if (size % 2 == 1) file.seekg(1, std::ios::cur);
    }

    fprintf(stderr, "error: the WAV file holds no samples\n");
    return false;
}

/**
 * Turn a number of centiseconds into "00:00:00,000".
 */
static std::string to_timestamp(int64_t centiseconds, bool comma) {
    int64_t ms = centiseconds * 10;
    int64_t hours = ms / (1000 * 60 * 60);
    ms -= hours * (1000 * 60 * 60);
    int64_t minutes = ms / (1000 * 60);
    ms -= minutes * (1000 * 60);
    int64_t seconds = ms / 1000;
    ms -= seconds * 1000;

    char buffer[32];
    snprintf(buffer, sizeof(buffer), "%02d:%02d:%02d%s%03d",
             static_cast<int>(hours), static_cast<int>(minutes),
             static_cast<int>(seconds), comma ? "," : ".", static_cast<int>(ms));
    return std::string(buffer);
}

/**
 * Write the segments as a SubRip file.
 */
static bool write_srt(struct whisper_context * ctx, const std::string & path) {
    std::ofstream out(path);
    if (!out) {
        fprintf(stderr, "error: the output file could not be written: %s\n", path.c_str());
        return false;
    }

    const int count = whisper_full_n_segments(ctx);
    for (int i = 0; i < count; i++) {
        const char * text = whisper_full_get_segment_text(ctx, i);
        const int64_t t0 = whisper_full_get_segment_t0(ctx, i);
        const int64_t t1 = whisper_full_get_segment_t1(ctx, i);

        // The text of a segment begins with a space, which has no meaning in
        // a subtitle file.
        while (*text == ' ' || *text == '\t') text++;

        out << (i + 1) << "\n";
        out << to_timestamp(t0, true) << " --> " << to_timestamp(t1, true) << "\n";
        out << text << "\n\n";
    }
    return true;
}

static void usage() {
    fprintf(stderr,
            "usage: whisper-cli -m MODEL -f AUDIO.wav -l LANG -of OUTPUT_BASE\n"
            "\n"
            "  -m FNAME  the model file\n"
            "  -f FNAME  the WAV file to read\n"
            "  -l LANG   the language of the speech, for example zh or auto\n"
            "  -of BASE  the name the result is written under, without an extension\n"
            "  -t N      the number of threads\n"
            "  --prompt TEXT  the text the model starts with, which tells it\n"
            "                 in what style and in what script to write\n"
            "  -np       no progress is printed\n"
            "  -pp       the progress is printed\n"
            "  --server DIR   stay running and watch DIR for requests, so that\n"
            "                 the model is loaded once and used for many files\n");
}

// ---------------------------------------------------------------------------
// The server mode
//
// Loading the model costs several seconds, and the plugin asks for one short
// piece of audio at a time. A run of the program per piece spends most of its
// time loading the model again and again. In the server mode the model is
// loaded once and the program stays running, watching a folder for requests.
//
// A request is a file named req-<id>.txt that holds four lines: the WAV file
// to read, the base name of the result, the language, and the prompt. The
// answer is a file named ack-<id>.txt that holds "OK" or "ERR <message>",
// and the result is written next to the base name, like in the one-shot run.
//
// The program leaves on its own after fifteen minutes without a request, so
// a player that went away cannot leave it behind for ever.
// ---------------------------------------------------------------------------

static const long SERVER_IDLE_LIMIT_SECONDS = 15 * 60;

static bool oldestRequest(const std::string & dir, std::string & reqPath, std::string & id) {
    DIR * d = opendir(dir.c_str());
    if (!d) return false;
    std::vector<std::string> names;
    struct dirent * e;
    while ((e = readdir(d)) != nullptr) {
        std::string name = e->d_name;
        if (name.rfind("req-", 0) != 0) continue;
        if (name.size() <= 8) continue;
        if (name.compare(name.size() - 4, 4, ".txt") != 0) continue;
        names.push_back(name);
    }
    closedir(d);
    if (names.empty()) return false;
    std::sort(names.begin(), names.end());
    reqPath = dir + "/" + names[0];
    id = names[0].substr(4, names[0].size() - 8);
    return true;
}

static void writeAck(const std::string & dir, const std::string & id, const std::string & message) {
    std::ofstream out(dir + "/ack-" + id + ".txt");
    out << message << std::endl;
}

static int serverMain(const std::string & dir, const std::string & model, int threads) {
    {
        std::ofstream pid(dir + "/server.pid");
        pid << getpid() << std::endl;
    }

    struct whisper_context_params contextParams = whisper_context_default_params();
    contextParams.use_gpu = true;
    struct whisper_context * ctx = whisper_init_from_file_with_params(model.c_str(), contextParams);
    if (ctx == nullptr) {
        std::ofstream failed(dir + "/server.failed");
        failed << "the model could not be loaded: " << model << std::endl;
        return 1;
    }

    time_t lastActivity = time(nullptr);
    whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);

    while (true) {
        std::string reqPath;
        std::string id;
        if (!oldestRequest(dir, reqPath, id)) {
            if (time(nullptr) - lastActivity > SERVER_IDLE_LIMIT_SECONDS) break;
            usleep(200000);
            continue;
        }
        lastActivity = time(nullptr);

        std::ifstream req(reqPath.c_str());
        std::string wavPath, outBase, language, prompt;
        std::getline(req, wavPath);
        std::getline(req, outBase);
        std::getline(req, language);
        std::getline(req, prompt);
        req.close();
        std::remove(reqPath.c_str());

        if (wavPath.empty() || outBase.empty()) {
            writeAck(dir, id, "ERR the request is incomplete");
            continue;
        }

        std::vector<float> samples;
        if (!read_wav(wavPath, samples) || samples.empty()) {
            writeAck(dir, id, "ERR the audio could not be read: " + wavPath);
            continue;
        }

        params.print_progress = false;
        params.print_realtime = false;
        params.print_special = false;
        params.print_timestamps = false;
        params.translate = false;
        params.single_segment = false;
        params.no_context = false;
        params.no_timestamps = false;
        params.suppress_blank = true;
        params.suppress_nst = false;
        params.progress_callback = nullptr;
        params.progress_callback_user_data = nullptr;
        params.language = language.c_str();
        params.detect_language = language == "auto";
        params.initial_prompt = prompt.empty() ? nullptr : prompt.c_str();
        params.n_threads = threads;

        if (whisper_full(ctx, params, samples.data(), static_cast<int>(samples.size())) != 0) {
            writeAck(dir, id, "ERR the speech could not be recognised");
            continue;
        }
        if (!write_srt(ctx, outBase + ".srt")) {
            writeAck(dir, id, "ERR the result could not be written");
            continue;
        }
        writeAck(dir, id, "OK");
    }

    whisper_free(ctx);
    std::remove((dir + "/server.pid").c_str());
    return 0;
}

int main(int argc, char ** argv) {
    std::string model;
    std::string audio;
    std::string language = "zh";
    std::string outputBase;
    std::string prompt;
    std::string serverDir;
    int threads = 0;

    for (int i = 1; i < argc; i++) {
        std::string arg = argv[i];
        auto next = [&](const char * name) -> std::string {
            if (i + 1 >= argc) {
                fprintf(stderr, "error: %s needs a value\n", name);
                exit(1);
            }
            return std::string(argv[++i]);
        };

        if (arg == "-m" || arg == "--model") {
            model = next("-m");
        } else if (arg == "-f" || arg == "--file") {
            audio = next("-f");
        } else if (arg == "-l" || arg == "--language") {
            language = next("-l");
        } else if (arg == "-of" || arg == "--output-file") {
            outputBase = next("-of");
        } else if (arg == "-t" || arg == "--threads") {
            threads = atoi(next("-t").c_str());
        } else if (arg == "--prompt") {
            // The text the model starts with. It is not written out, but the
            // model writes in the style and in the script of it, which is
            // how the caller asks for Simplified Chinese or for Traditional
            // Chinese.
            prompt = next("--prompt");
        } else if (arg == "--server") {
            serverDir = next("--server");
        } else if (arg == "-osrt" || arg == "--output-srt") {
            // The program writes a SubRip file and nothing else, so the
            // format the caller asks for is the one it gets. The option is
            // accepted so that the same command line works for this program
            // and for the one of whisper.cpp.
        } else if (arg == "-np" || arg == "--no-prints") {
            show_progress = false;
        } else if (arg == "-pp" || arg == "--print-progress") {
            show_progress = true;
        } else if (arg == "-h" || arg == "--help") {
            usage();
            return 0;
        } else {
            fprintf(stderr, "error: the option is not known: %s\n", arg.c_str());
            usage();
            return 1;
        }
    }

    if (model.empty()) {
        usage();
        return 1;
    }

    if (!serverDir.empty()) {
        int threadsToUse = threads > 0 ? threads : std::min(4, static_cast<int32_t>(std::thread::hardware_concurrency()));
        return serverMain(serverDir, model, threadsToUse);
    }

    std::vector<float> samples;
    if (!read_wav(audio, samples)) {
        return 1;
    }
    if (samples.empty()) {
        fprintf(stderr, "error: the file holds no sound\n");
        return 3;
    }

    struct whisper_context_params contextParams = whisper_context_default_params();
    contextParams.use_gpu = true;

    struct whisper_context * ctx = whisper_init_from_file_with_params(model.c_str(), contextParams);
    if (ctx == nullptr) {
        fprintf(stderr, "error: the model could not be loaded: %s\n", model.c_str());
        return 1;
    }

    struct whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    params.print_progress = false;
    params.print_realtime = false;
    params.print_special = false;
    params.print_timestamps = false;
    params.translate = false;
    params.single_segment = false;
    params.no_context = false;
    params.no_timestamps = false;
    params.detect_language = false;
    params.suppress_blank = true;
    params.suppress_nst = false;
    params.language = language.c_str();
    params.detect_language = language == "auto";
    if (!prompt.empty()) {
        // The text is the context the model starts with. It is not written
        // out itself, but the model writes in the style and in the script of
        // it, which is how the caller asks for Simplified Chinese or for
        // Traditional Chinese.
        params.initial_prompt = prompt.c_str();
    }
    params.n_threads = threads > 0 ? threads : std::min(4, static_cast<int32_t>(std::thread::hardware_concurrency()));
    params.progress_callback = progress_callback;
    params.progress_callback_user_data = nullptr;

    if (whisper_full(ctx, params, samples.data(), static_cast<int>(samples.size())) != 0) {
        fprintf(stderr, "error: the speech could not be recognised\n");
        whisper_free(ctx);
        return 1;
    }

    const bool ok = write_srt(ctx, outputBase + ".srt");
    whisper_free(ctx);
    return ok ? 0 : 1;
}
