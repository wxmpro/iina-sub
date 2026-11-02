/**
 * The script of the Chinese subtitles.
 *
 * A speech recognition model writes Chinese in whichever script it thinks
 * it heard: a model that is asked for Chinese answers with Traditional
 * characters as often as with Simplified ones, and it may even change the
 * script in the middle of a file. Two things keep the subtitles in the
 * script that the user asked for:
 *
 *   - the model is given a short text to start with, in that script, so it
 *     writes in it by itself;
 *   - what the model wrote anyway is brought into that script afterwards.
 *
 * The second one is the fallback for the engines that take no prompt, and
 * it costs nothing when the model already wrote the right script.
 */
const zh = require("./zh.js");

const SIMPLIFIED = "simplified";
const TRADITIONAL = "traditional";
const AS_IS = "as-is";

/**
 * The script that was asked for.
 *
 * A setting that holds something else is read as Simplified Chinese, which
 * is the script that the plugin asks for by default.
 */
function scriptOf(settings) {
  const value = String(
    (settings && settings.subtitleScript) || SIMPLIFIED
  ).toLowerCase();
  if (value === TRADITIONAL) return TRADITIONAL;
  if (
    value === AS_IS ||
    value === "asis" ||
    value === "keep" ||
    value === "none" ||
    value === "original"
  ) {
    return AS_IS;
  }
  return SIMPLIFIED;
}

/**
 * Whether the speech recognition is told to listen for Chinese.
 */
function isChinese(language) {
  const value = String(language || "").toLowerCase();
  return value === "zh" || value.indexOf("zh-") === 0 || value.indexOf("zh_") === 0;
}

/**
 * The text the model is given before it starts.
 *
 * The text holds no punctuation. A prompt that ends in a full stop makes the
 * model write long sentences, and a subtitle file wants short ones: the
 * same audio gave 59 cues without a prompt, 37 with a short one and 5 with
 * one that ended in a full stop.
 *
 * The prompt is only given when the recognition is told to listen for
 * Chinese. A Chinese prompt would make a model that listens for Japanese
 * write Chinese.
 */
function promptFor(settings) {
  const script = scriptOf(settings);
  if (script === AS_IS) return "";
  if (!isChinese(settings && settings.language)) return "";
  return script === TRADITIONAL ? "繁體中文" : "简体中文";
}

/**
 * Bring a text into the script that was asked for.
 *
 * A text of a language that is not Chinese is left as it is: the tables of
 * OpenCC would change the Chinese characters of Japanese and of Korean.
 */
function applyTo(text, settings) {
  const script = scriptOf(settings);
  if (script === AS_IS) return text;

  const value = String(text === undefined || text === null ? "" : text);
  if (!value) return value;

  const language = String((settings && settings.language) || "").toLowerCase();
  if (language && language !== "auto" && !isChinese(language)) return value;
  if (!isChinese(language) && !zh.looksChinese(value)) return value;

  return script === TRADITIONAL ? zh.toTraditional(value) : zh.toSimplified(value);
}

/**
 * Bring the text of every cue into the script that was asked for.
 */
function applyToCues(cues, settings) {
  if (!cues || !cues.length) return cues;
  if (scriptOf(settings) === AS_IS) return cues;
  for (const cue of cues) {
    if (cue && typeof cue.text === "string") {
      cue.text = applyTo(cue.text, settings);
    }
  }
  return cues;
}

module.exports = {
  scriptOf,
  isChinese,
  promptFor,
  applyTo,
  applyToCues,
  SIMPLIFIED,
  TRADITIONAL,
  AS_IS,
};
