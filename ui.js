const { core, utils, sidebar, console } = iina;

const { state } = require("./state.js");
const i18n = require("./i18n.js");
const srt = require("./srt.js");


/**
 * A text that is safe to hand over to the sidebar.
 *
 * The sidebar is a web page, and the player builds the call that reaches it
 * out of the text itself. The name of a file is therefore not sent as text
 * at all: it is sent as the bytes of it, written out as hex, and the
 * sidebar turns it back into text on its own.
 *
 * A name that held a mark of JavaScript therefore cannot be carried out in
 * the sidebar, whatever the player does with the text around it. The name
 * itself also stays readable, because nothing is thrown away.
 */
function encodeText(value) {
  const bytes = srt.utf8Bytes(String(value === undefined || value === null ? "" : value));
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Say something on the screen of the player.
 *
 * The name of the plugin is written in front of every message, so that the
 * user knows where the message comes from.
 */
function osd(text) {
  core.osd("iina-sub: " + i18n.t(text));
}

/**
 * Ask the user a question.
 *
 * The name of the plugin is written in front of the question, so that the
 * user knows where the question comes from.
 */
function ask(text, ...values) {
  return utils.ask("iina-sub\n\n" + i18n.t(text, ...values));
}

/**
 * Ask the user to write something.
 */
function prompt(text, ...values) {
  return utils.prompt("iina-sub\n\n" + i18n.t(text, ...values));
}

/**
 * Report progress to the player and the sidebar.
 */
function pushStatus(status, ...values) {
  const given = status || {};
  const payload = {
    phase: String(given.phase || "idle"),
    message: encodeText(i18n.t(given.message, ...values)),
    detail: encodeText(i18n.t(given.detail, ...values)),
    percent: Number(given.percent) || 0,
    video: encodeText(given.video),
    elapsed: Number(given.elapsed) || 0,
  };
  try {
    sidebar.postMessage("status", payload);
  } catch (e) {
    // The sidebar may not be loaded yet. This is not worth a message of its
    // own, but a real failure has to be visible.
    console.warn("iina-sub: the sidebar did not take the status: " + e);
  }
}

function logActivity(text) {
  state.activityLog.unshift({
    time: new Date().toLocaleTimeString(),
    text: encodeText(i18n.t(text)),
  });
  while (state.activityLog.length > 50) state.activityLog.pop();
  try {
    sidebar.postMessage("activity", { entries: state.activityLog });
  } catch (e) {
    console.warn("iina-sub: the sidebar did not take the activity: " + e);
  }
}

/**
 * A short form of a message, so that the screen of the player is not filled
 * with the help of a program that complained.
 */
function shortMessage(text) {
  const message = String(text || "").split("\n")[0].trim();
  return message.length > 200 ? message.slice(0, 200) + "…" : message;
}

function baseName(path) {
  if (!path) return "";
  const parts = path.split("/");
  return parts[parts.length - 1];
}

function directoryOf(path) {
  if (!path) return "";
  const index = path.lastIndexOf("/");
  return index > 0 ? path.substring(0, index) : "/";
}

module.exports = {
  encodeText,
  pushStatus,
  logActivity,
  shortMessage,
  baseName,
  directoryOf,
  osd,
  ask,
  prompt,
};
