#!/usr/bin/env python3
"""Rebuild zh.js from the dictionaries of OpenCC.

The tables in zh.js are the dictionary data of OpenCC. They are copied out
of an installed OpenCC so that the plugin can bring the script of Chinese
subtitles to the one the user asked for, with no program to install and no
network to use.

    python3 tools/build-zh.py

The dictionaries are read from the `opencc` package of Python:

    python3 -c "import opencc, os; print(os.path.dirname(opencc.__file__))"

Two directions are built.

Traditional to Simplified is the chain of OpenCC for tw2sp:

    TWPhrasesRev -> TWVariantsRevPhrases -> TWVariantsRev
    TSPhrases -> TSCharacters

The first group holds the words that are written differently in Taiwan, the
second one the words and the characters that are written differently in
Traditional Chinese. A group is a list of tables: the tables are looked at
in order and the first one that matches a piece of text wins, so a word of
its own is protected from a shorter rule. That is why 著名 stays 著名 and
does not become 着名.

Simplified to Traditional uses the characters of s2t. The words of s2t are
left out: they weigh a megabyte, and the direction is only used to put back
the few characters that the model wrote in the wrong script.
"""
import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TARGET = os.path.join(ROOT, "zh.js")

TABLES = [
    ("CHARACTERS", "TSCharacters.txt"),
    ("TW_VARIANT_PHRASES", "TWVariantsRevPhrases.txt"),
    ("PHRASES", "TSPhrases.txt"),
    ("S2T_CHARACTERS", "STCharacters.txt"),
]

HEADER = '''/**
 * Chinese in the script the user asked for.
 *
 * The speech recognition model writes Chinese in whichever script it thinks
 * it heard: a model that is asked for Chinese answers with Traditional
 * characters as often as with Simplified ones, and it may even change the
 * script in the middle of a file. The tables below turn one script into the
 * other, so that the subtitles of a Chinese video read the way the person
 * who recorded it wrote.
 *
 * The tables are the dictionary data of OpenCC (https://github.com/BYVoid/OpenCC),
 * which is under the Apache License 2.0. The copy of the licence is in
 * docs/OPENCC-LICENSE.txt.
 *
 * A word is looked at first, from the longest one to the shortest one, and a
 * character that is in no word is looked up on its own. A text that holds
 * nothing that the tables know is left as it is, so the conversion costs
 * nothing for the files that are already in the script that is wanted.
 */

'''

BODY = '''
/**
 * The tables, read once.
 *
 * A group is a list of tables. OpenCC looks at the tables of a group in
 * order, and the first one that matches a piece of text wins: the text it
 * matched is not looked at by the tables that come after it.
 */
const groups = [];
const traditionalCharacters = new Set();
const simplifiedCharacters = new Set();

function readPairs(text, into, characters) {
  for (const line of text.split("\\n")) {
    if (!line) continue;
    const tab = line.indexOf("\\t");
    if (tab < 0) continue;
    const source = line.slice(0, tab);
    const target = line.slice(tab + 1);
    into.set(source, target);
    for (const ch of source) characters.add(ch);
  }
}

/**
 * Read one table and remember how long its longest word is.
 */
function readTable(text, characters) {
  const map = new Map();
  readPairs(text, map, characters);
  let longest = 1;
  for (const key of map.keys()) {
    if (key.length > longest) longest = key.length;
  }
  return { map: map, longest: longest };
}

const twVariantPhrases = readTable(TW_VARIANT_PHRASES, traditionalCharacters);
const zheVariant = readTable(ZHE_VARIANT, traditionalCharacters);
const phrases = readTable(PHRASES, traditionalCharacters);
const characters = readTable(CHARACTERS, traditionalCharacters);
const s2tCharacters = readTable(S2T_CHARACTERS, simplifiedCharacters);

// The first group holds the words that protect a character from a shorter
// rule: 著 in 著名 is one of them. The second group holds the words and
// the characters that are written differently in Traditional Chinese.
//
// The words of Taiwan are not in the chain: they change the meaning of a
// text and not only its script. A text that says 序列 is turned into 串行
// by them, and 核心 into 内核, and there are 122 such words.
groups.push([twVariantPhrases, zheVariant]);
groups.push([phrases, characters]);

/**
 * The first spelling of a word that has more than one.
 */
function firstSpelling(value) {
  const space = value.indexOf(" ");
  return space === -1 ? value : value.slice(0, space);
}

/**
 * Replace the words of one group.
 *
 * The tables of the group are looked at in order, and the first one that
 * matches at the place the text is at wins. A word that is in no table is
 * left as it is.
 */
function applyGroup(text, group) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    let hit = false;
    for (const table of group) {
      const limit = Math.min(table.longest, text.length - i);
      for (let length = limit; length >= 1; length--) {
        const value = table.map.get(text.substr(i, length));
        if (value === undefined) continue;
        out += firstSpelling(value);
        i += length;
        hit = true;
        break;
      }
      if (hit) break;
    }
    if (!hit) {
      out += text[i];
      i++;
    }
  }
  return out;
}

/**
 * Whether a text holds a character that the tables know.
 *
 * The check is what makes the conversion cheap: a text that is already in
 * the script that is wanted is returned as it is, and the tables are not
 * even looked at.
 */
function holdsTraditional(text) {
  for (const ch of text) {
    if (traditionalCharacters.has(ch)) return true;
  }
  return false;
}

function holdsSimplified(text) {
  for (const ch of text) {
    if (simplifiedCharacters.has(ch)) return true;
  }
  return false;
}

/**
 * Turn a text in Traditional Chinese into Simplified Chinese.
 *
 * A text that holds nothing that the tables know is returned as it is.
 */
function toSimplified(text) {
  const value = String(text === undefined || text === null ? "" : text);
  if (!value || !holdsTraditional(value)) return value;

  let out = value;
  for (const group of groups) {
    out = applyGroup(out, group);
  }
  return out;
}

/**
 * Turn a text in Simplified Chinese into Traditional Chinese.
 */
function toTraditional(text) {
  const value = String(text === undefined || text === null ? "" : text);
  if (!value || !holdsSimplified(value)) return value;

  let out = "";
  for (const ch of value) {
    const converted = s2tCharacters.map.get(ch);
    if (converted === undefined) {
      out += ch;
      continue;
    }
    // A character that has more than one form in Traditional Chinese is
    // written as its first one, which is what OpenCC does as well.
    out += firstSpelling(converted);
  }
  return out;
}

/**
 * Whether a text is Chinese.
 *
 * The kana of Japanese and the letters of Korean are what tell the scripts
 * of the two apart: a text that holds none of them and that holds Chinese
 * characters is Chinese. A text of Japanese that is written with nothing
 * but Chinese characters is rare, and it is left alone when the language of
 * the user is known.
 */
function looksChinese(text) {
  const value = String(text === undefined || text === null ? "" : text);
  let han = 0;
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code >= 0x3040 && code <= 0x30ff) return false;
    if (code >= 0xac00 && code <= 0xd7af) return false;
    if (code >= 0x1100 && code <= 0x11ff) return false;
    if (code >= 0x3130 && code <= 0x318f) return false;
    if (code >= 0x4e00 && code <= 0x9fff) han++;
  }
  return han > 0;
}

module.exports = {
  toSimplified,
  toTraditional,
  holdsTraditional,
  holdsSimplified,
  looksChinese,
};
'''


def find_dictionary_dir():
    try:
        import opencc
    except ImportError:
        sys.exit("The opencc package is not installed: pip install opencc")
    directory = os.path.join(os.path.dirname(opencc.__file__), "dictionary")
    if not os.path.isdir(directory):
        sys.exit("The dictionary folder of opencc was not found: " + directory)
    return directory


def read_pairs(directory, name):
    pairs = []
    with io.open(os.path.join(directory, name), encoding="utf-8") as handle:
        for line in handle:
            line = line.rstrip("\n")
            if not line:
                continue
            parts = line.split("\t")
            if len(parts) < 2:
                continue
            source, target = parts[0], parts[1]
            if not source or not target:
                continue
            # A pair that is written the same in both scripts is kept: it is
            # the way OpenCC protects a word from a shorter rule. 著名 is
            # such a word — without the entry it would become 着名.
            pairs.append((source, target))
    return pairs


def main():
    directory = find_dictionary_dir()
    # 著 is a character of both scripts: in 著名 it stays 著, and in 寫著 it
    # is the 着 of the mainland form. The words in which it stays are the
    # ones of the table of OpenCC that protects them; everything else is
    # turned into 着.
    zhe = "著\t着"

    with io.open(TARGET, "w", encoding="utf-8") as out:
        out.write(HEADER)
        for name, filename in TABLES:
            pairs = read_pairs(directory, filename)
            body = "\n".join(a + "\t" + b for a, b in pairs)
            out.write("/** " + filename + " — " + str(len(pairs)) + " entries. */\n")
            out.write("const " + name + " = " + json.dumps(body, ensure_ascii=False) + ";\n\n")
        out.write("/** The character that is written 着 in the mainland form. */\n")
        out.write("const ZHE_VARIANT = " + json.dumps(zhe, ensure_ascii=False) + ";\n\n")
        out.write(BODY)
    print("written: " + TARGET)


if __name__ == "__main__":
    main()
