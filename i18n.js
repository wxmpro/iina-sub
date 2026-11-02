const { utils, preferences, console } = iina;

/**
 * The language of the plugin.
 *
 * Every string that the user can read is written in the code in English and
 * is the key of the dictionary below. A user whose system speaks Chinese
 * gets the Chinese text; everybody else gets the English text that is in
 * the code. Nothing is lost when a string has no entry: the text itself is
 * used, so a string that was forgotten is still readable.
 *
 * The placeholders of a string are written as {0}, {1} and so on, and they
 * are filled in with the values that are given to `t`.
 */
const DICTIONARY = {
  // The menu
  "Generate Subtitles Now": "立即生成字幕",
  "Export Subtitles Next to the Video": "把字幕导出到视频旁",
  "Transcribe All Videos in This Folder": "转写本文件夹中的所有视频",
  "Regenerate Subtitles (discard the cache)": "重新生成字幕（清除缓存）",
  "Cancel Transcription (stop the current run)": "取消转写（停止当前任务）",

  // The messages on the screen of the player
  "loaded cached subtitles": "已载入缓存的字幕",
  "subtitles ready": "字幕已就绪",
  "subtitles ready, but {0} chunks failed": "字幕已就绪，但有 {0} 段失败",
  "transcription cancelled": "转写已取消",
  "starting transcription": "开始转写",
  "a transcription is already running": "已有一个转写任务正在进行",
  "batch started ({0} files)": "批量转写已开始（{0} 个文件）",
  "batch finished": "批量转写已完成",
  "batch stopped after the current file": "当前文件完成后停止批量转写",
  "nothing is running": "当前没有任务在运行",
  "cancelling after the current chunk": "当前这一段完成后取消",
  "a batch run is already in progress": "已有一个批量转写任务正在进行",
  "saved {0}": "已保存 {0}",
  "{0} files removed": "已删除 {0} 个文件",
  "downloading {0}": "正在下载 {0}",
  "{0} is ready": "{0} 已就绪",
  "the speech recognition program is ready": "语音识别程序已就绪",

  // The state that the sidebar shows
  "Ready": "就绪",
  "Cached subtitles loaded": "已载入缓存的字幕",
  "No subtitles yet": "还没有字幕",
  "Transcribing": "正在转写",
  "Chunk {0} / {1}": "第 {0} / {1} 段",
  "Chunk {0} / {1} failed": "第 {0} / {1} 段失败",
  "Cancelled": "已取消",
  "Failed": "失败",
  "Done": "完成",
  "Done with gaps": "完成，但有缺失",
  "Starting": "开始中",
  "Batch finished": "批量转写已完成",
  "The saved transcripts were removed": "已删除保存的字幕",
  "Downloading {0}": "正在下载 {0}",
  "Downloading {0} from a mirror": "正在从镜像下载 {0}",
  "The engine is not ready": "引擎尚未就绪",
  "The speech recognition program is missing": "缺少语音识别程序",
  "Use the sidebar tab of the plugin to fetch it": "可在插件的侧边栏中获取",
  "No model yet": "还没有模型",
  "Use the sidebar tab of the plugin to fetch one": "可在插件的侧边栏中获取",
  "Fetching the speech recognition program": "正在获取语音识别程序",
  "The speech recognition program is ready": "语音识别程序已就绪",
  "Checking the speech recognition program": "正在校验语音识别程序",
  "Unpacking the speech recognition program": "正在解压语音识别程序",

  // The notes of the models
  "Fastest. Low accuracy, mainly useful for testing.": "最快。精度较低，主要用于测试。",
  "Still very fast. Noticeably weaker than the larger models.": "依然很快，但明显弱于更大的模型。",
  "Good compromise for English. Chinese quality is limited.": "英文效果不错，中文效果有限。",
  "Strong accuracy, moderate speed.": "精度高，速度适中。",
  "Best speed to accuracy ratio. Recommended for Chinese.": "速度与精度兼顾最好，中文推荐使用。",
  "Highest accuracy of the quantised models. About twice as slow as turbo.":
    "量化模型中精度最高，速度约为 turbo 的一半。",
  "  (already downloaded)": "  （已下载）",

  // The small log of the sidebar
  "Transcribed {0}": "已转写 {0}",
  "Failed: {0} — {1}": "失败：{0} — {1}",
  "Cached {0}": "已有缓存：{0}",
  "Skipped {0} — unknown duration": "已跳过 {0} — 未知时长",
  "Exported {0}": "已导出 {0}",
  "Removed the saved transcripts": "已删除保存的字幕",
  "Fetched the speech recognition program": "已获取语音识别程序",
  "Fetched {0}": "已获取 {0}",
  "No speech recognition program yet — the fetch was declined": "尚未获取语音识别程序 — 已取消下载",
  "No model yet — the fetch was declined": "尚无模型 — 已取消下载",
  "Batch stopped: {0}": "批量转写已停止：{0}",

  // The questions of the plugin
  "Open a local video first. Network streams are not supported.":
    "请先打开一个本地视频。本插件不支持网络流。",
  "Open a local video first.": "请先打开一个本地视频。",
  "Open a local video first, then every video next to it can be transcribed in one go.":
    "请先打开一个本地视频，之后即可一次性转写同目录下的所有视频。",
  "No video files were found next to this file.": "在该文件旁边没有找到视频文件。",
  "Transcribe {0} video file(s) in this folder?\n\n{1}":
    "要转写本文件夹中的 {0} 个视频文件吗？\n\n{1}",
  "There are no subtitles for this video yet.\n\nUse Generate Subtitles Now first.":
    "这个视频还没有字幕。\n\n请先使用“立即生成字幕”。",
  "This video is still being transcribed.\n\nWait until it is done, then export the subtitles.":
    "这个视频还在转写中。\n\n请等转写完成后再导出字幕。",
  "The subtitles of this video are not complete. Some parts of the file could not be transcribed.\n\nExport them anyway?":
    "这个视频的字幕并不完整，部分内容未能转写。\n\n仍要导出吗？",
  "A subtitle file for this video cannot be placed next to it.":
    "无法在这个视频旁边放置字幕文件。",
  "There is a folder named {0} in the way.\n\nRemove it and try again.":
    "存在名为 {0} 的同名文件夹挡在那里。\n\n请删除后重试。",
  "The subtitle file could not be written.\n\n{0}": "字幕文件无法写入。\n\n{0}",
  "Remove every transcript that the plugin has kept?\n\nThe videos themselves are not touched, and the subtitle files next to them are not touched either.":
    "要删除插件保存的全部字幕吗？\n\n视频本身不会被改动，视频旁边的字幕文件也不会被改动。",
  "There is no model called \"{0}\".": "没有名为“{0}”的模型。",
  "there is no model to remove": "没有需要删除的模型",
  "{0} models removed": "已删除 {0} 个模型",
  "Removed {0} models": "已删除 {0} 个模型",
  "There is no model folder to clean up.": "没有需要清理的模型目录。",
  "Remove the {0} model(s) that the plugin has downloaded?\n\nA model has to be downloaded again before the plugin can transcribe anything, and the download is a few hundred megabytes.":
    "要删除插件已下载的 {0} 个模型吗？\n\n删除后需要重新下载模型才能转写，而下载量有几百 MB。",
  "There is no model called \"{0}\".\n\n{1}": "没有名为“{0}”的模型。\n\n{1}",
  "Type the name of the model to download. Leave the field empty for the recommended one.\n\n{0}":
    "请输入要下载的模型名称。留空则下载推荐的模型。\n\n{0}",
  "The model could not be downloaded.\n\n{0}": "模型下载失败。\n\n{0}",
  "The speech recognition program could not be fetched.\n\n{0}": "语音识别程序获取失败。\n\n{0}",

  // The long questions
  "Speech recognition needs a program. The plugin can fetch its own copy (about 4 MB, once) and keep it in its folder.\n\nFetch it now?\n\nHomebrew users can install whisper.cpp instead with:\nbrew install whisper.cpp":
    "语音识别需要一个程序。插件可以自行下载一份（约 4 MB，仅需一次）并保存在插件目录中。\n\n现在下载吗？\n\n已安装 Homebrew 的用户也可以改用下面的命令安装 whisper.cpp：\nbrew install whisper.cpp",
  "To show subtitles, a speech model is needed. It is downloaded once ({0}), kept in the folder of the plugin, and works without network after that.\n\nFetch {1} now?":
    "显示字幕需要一个语音模型。它只需下载一次（{0}），保存在插件目录中，之后无需联网即可使用。\n\n现在下载 {1} 吗？",
};

/**
 * The language that is used at the moment.
 */
let current = "en";

/**
 * Whether the Chinese text is used.
 */
function isChinese() {
  return current === "zh";
}

/**
 * The language that is used at the moment.
 */
function locale() {
  return current;
}

/**
 * Translate a string.
 *
 * A string that is not in the dictionary is used as it is, so a string that
 * was forgotten is still shown and never shows as an empty line.
 */
function t(text, ...values) {
  let out = String(text === undefined || text === null ? "" : text);
  if (current === "zh") {
    const entry = DICTIONARY[out];
    if (entry !== undefined) out = entry;
  }
  if (values.length === 0) return out;
  return out.replace(/\{(\d+)\}/g, (whole, index) => {
    const value = values[Number(index)];
    return value === undefined || value === null ? whole : String(value);
  });
}

/**
 * The language that the system speaks.
 *
 * The setting of the system is asked for once, when the plugin starts. The
 * program that is asked is one of macOS itself, and it is only asked a
 * question about the language.
 */
async function systemLocale() {
  try {
    const res = await utils.exec("/usr/bin/defaults", ["read", "-g", "AppleLocale"]);
    if (!res || res.status !== 0) return "en";
    const value = String(res.stdout || "").trim().toLowerCase();
    if (value.indexOf("zh") === 0 || value.indexOf("zh-") === 0) return "zh";
    return "en";
  } catch (e) {
    return "en";
  }
}

/**
 * Work out the language of the plugin and remember it.
 *
 * The setting of the user comes first: it can be "auto", and then the
 * language of the system is used.
 */
async function init() {
  const chosen = String(preferences.get("uiLanguage") || "auto").trim().toLowerCase();
  if (chosen === "zh" || chosen.indexOf("zh-") === 0 || chosen.indexOf("zh_") === 0) {
    current = "zh";
    return current;
  }
  if (chosen === "en" || chosen.indexOf("en-") === 0 || chosen.indexOf("en_") === 0) {
    current = "en";
    return current;
  }
  current = await systemLocale();
  return current;
}

module.exports = { t, init, locale, isChinese, DICTIONARY };
