#!/usr/bin/env bun
// @bun

// ../findeverything-service-20261020/src/cli.ts
import * as fs15 from "fs";
import * as path14 from "path";
import { spawn as spawn6 } from "child_process";

// ../findeverything-service-20261020/src/catalog.ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
var CONFIG_DIR = process.env.FE_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "find-everything");
var BUILTIN_SCOPES = ["home", "downloads", "documents", "applications", "all", "custom"];
var catalogFile = path.join(CONFIG_DIR, "indexes.json");
function validateName(name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name))
    throw new Error("Index name must be 1\u201364 letters, numbers, hyphens or underscores");
  return name;
}
function canonicalPaths(inputs) {
  if (!inputs.length)
    throw new Error("Specify at least one folder");
  if (inputs.length > 64)
    throw new Error("Use at most 64 root folders per index");
  const roots = [...new Set(inputs.map((input) => {
    const expanded = input === "~" ? os.homedir() : input.startsWith("~/") ? path.join(os.homedir(), input.slice(2)) : input;
    const p = fs.realpathSync(path.resolve(expanded));
    if (!fs.statSync(p).isDirectory())
      throw new Error(`Not a folder: ${input}`);
    if (/[\r\n]/.test(p))
      throw new Error("Folder names containing line breaks are unsupported");
    return p;
  }))].sort();
  return roots.filter((p, i) => !roots.slice(0, i).some((parent) => p.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep)));
}
function profiles() {
  if (!fs.existsSync(catalogFile))
    return [];
  if (fs.statSync(catalogFile).size > 1024 * 1024)
    throw new Error("Index catalog exceeds 1 MiB");
  const data = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
  if (data.version !== 1 || !Array.isArray(data.indexes) || data.indexes.length > 256)
    throw new Error(`Invalid catalog: ${catalogFile}`);
  const names = new Set;
  return data.indexes.map((p) => {
    validateName(p.name);
    if (names.has(p.name) || BUILTIN_SCOPES.includes(p.name) || !Array.isArray(p.paths) || !p.paths.length || p.paths.length > 64 || p.paths.some((v) => typeof v !== "string" || !path.isAbsolute(v) || /[\r\n]/.test(v)) || p.includeHidden !== undefined && typeof p.includeHidden !== "boolean" || p.includeIgnored !== undefined && typeof p.includeIgnored !== "boolean" || p.extraExcludes !== undefined && typeof p.extraExcludes !== "string" || p.indexMaxAgeMinutes !== undefined && (!Number.isFinite(Number(p.indexMaxAgeMinutes)) || Number(p.indexMaxAgeMinutes) < 1 || Number(p.indexMaxAgeMinutes) > 10080))
      throw new Error(`Invalid index profile: ${p.name}`);
    names.add(p.name);
    return p;
  });
}
function profile(name) {
  return profiles().find((p) => p.name === name);
}
function defaultIndex() {
  return profiles().some((p) => p.name === "everything") ? "everything" : "home";
}
function saveProfile(item, replace = false) {
  validateName(item.name);
  if (BUILTIN_SCOPES.includes(item.name))
    throw new Error(`Reserved index name: ${item.name}`);
  const validated = { ...item, paths: canonicalPaths(item.paths) };
  editCatalog((items) => {
    if (!replace && items.some((p) => p.name === item.name))
      throw new Error(`Index already exists: ${item.name}; use --replace to update it`);
    return [...items.filter((p) => p.name !== item.name), validated];
  });
}
function removeProfile(name) {
  editCatalog((items) => {
    if (!items.some((p) => p.name === name))
      throw new Error(`Unknown index: ${name}`);
    return items.filter((p) => p.name !== name);
  });
}
function editCatalog(edit) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 448 });
  const lock = `${catalogFile}.lock`;
  const release = acquireLock(lock);
  const tmp = `${catalogFile}.${randomUUID()}.tmp`;
  try {
    const items = edit(profiles());
    if (items.length > 256)
      throw new Error("Use at most 256 saved indexes");
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, indexes: items }, null, 2) + `
`, { mode: 384 });
    fs.renameSync(tmp, catalogFile);
  } finally {
    release();
    fs.rmSync(tmp, { force: true });
  }
}
function acquireLock(file) {
  for (let attempt = 0;attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx", 384);
      fs.writeFileSync(fd, String(process.pid));
      return () => {
        fs.closeSync(fd);
        fs.rmSync(file, { force: true });
      };
    } catch (e) {
      if (e.code !== "EEXIST")
        throw e;
      let abandoned = false;
      try {
        const owner = Number(fs.readFileSync(file, "utf8"));
        if (Number.isInteger(owner) && owner > 0) {
          try {
            process.kill(owner, 0);
          } catch (cause) {
            if (cause.code === "ESRCH")
              abandoned = true;
          }
        } else
          abandoned = Date.now() - fs.statSync(file).mtimeMs > 30000;
      } catch (cause) {
        if (cause.code === "ENOENT")
          continue;
        throw cause;
      }
      if (abandoned && attempt === 0) {
        fs.rmSync(file, { force: true });
        continue;
      }
      throw new Error(`Index/catalog is busy; another process holds ${path.basename(file)}`);
    }
  }
  throw new Error("Could not acquire index lock; retry shortly");
}
function pathIndexName(paths, options) {
  return `path-${createHash("sha256").update(JSON.stringify([paths, options])).digest("hex").slice(0, 16)}`;
}

// ../findeverything-service-20261020/src/engine.ts
import { spawn } from "child_process";
import * as fs4 from "fs";
import * as os3 from "os";
import * as path4 from "path";

// ../findeverything-service-20261020/src/file-filters.ts
import fs2 from "fs";
import os2 from "os";
import path2 from "path";
import { randomUUID as randomUUID2 } from "crypto";
var favoritesFile = () => process.env.FE_FAVORITES_FILE || path2.join(os2.homedir(), "Library/Application Support/FindEverything/pins.json");
function favoritePaths() {
  const file = favoritesFile();
  try {
    if (fs2.statSync(file).size > 2 * 1024 * 1024)
      throw new Error("Favorites exceed 2 MiB");
    const values = JSON.parse(fs2.readFileSync(file, "utf8"));
    if (!Array.isArray(values) || values.length > 1e4 || values.some((p) => typeof p !== "string" || !path2.isAbsolute(p) || p.length > 4096 || /[\r\n\0]/.test(p)))
      throw new Error("Invalid favorites file");
    return [...new Set(values)];
  } catch (e) {
    if (e.code === "ENOENT")
      return [];
    throw e;
  }
}
function changeFavorites(action, values) {
  if (!["list", "add", "remove"].includes(action))
    throw new Error("Use favorites list, add PATH or remove PATH");
  if (action === "list")
    return { paths: favoritePaths() };
  if (!values.length || values.some((p) => !path2.isAbsolute(p) || p.length > 4096 || /[\r\n\0]/.test(p)))
    throw new Error("Favorites require absolute paths without line breaks");
  const file = favoritesFile();
  fs2.mkdirSync(path2.dirname(file), { recursive: true, mode: 448 });
  const release = acquireLock(file + ".lock");
  try {
    const previous = favoritePaths(), set = new Set(previous);
    for (const value of values)
      if (action === "add")
        set.add(value);
      else
        set.delete(value);
    const paths = [...set];
    if (paths.length > 1e4)
      throw new Error("Favorites are limited to 10000 paths");
    const data = JSON.stringify(paths);
    if (Buffer.byteLength(data) > 2 * 1024 * 1024)
      throw new Error("Favorites exceed 2 MiB");
    if (JSON.stringify(previous) !== data) {
      const temporary = file + "." + randomUUID2();
      try {
        fs2.writeFileSync(temporary, data, { mode: 384 });
        fs2.renameSync(temporary, file);
      } finally {
        fs2.rmSync(temporary, { force: true });
      }
    }
    return { paths };
  } finally {
    release();
  }
}
var GENERATED = ["node_modules", ".git", ".build", "__pycache__", ".cache", ".venv", "target", "DerivedData", ".next", "dist", "build", ".turbo"];
var ruleCache = new Map;
function omissionRules(kinds) {
  const key = kinds.join(";"), cached = ruleCache.get(key);
  if (cached)
    return cached;
  const rules = [];
  if (kinds.includes("system"))
    for (const root of ["/System/", "/Library/", "/private/", "/usr/", "/bin/", "/sbin/", "/dev/", os2.homedir() + "/Library/"])
      rules.push({ glob: root.toLowerCase() + "*", term: root.split("/").filter(Boolean).at(-1).toLowerCase() });
  if (kinds.includes("generated"))
    for (const name of GENERATED)
      rules.push({ glob: "*/" + name.toLowerCase() + "/*", term: name.toLowerCase() });
  if (ruleCache.size >= 8)
    ruleCache.delete(ruleCache.keys().next().value);
  ruleCache.set(key, rules);
  return rules;
}
function omitted(p, kinds = []) {
  if (!kinds.length)
    return false;
  const value = p.toLowerCase();
  if (kinds.includes("hidden") && /(?:^|\/)\.[^/]/.test(p))
    return true;
  return omissionRules(kinds).some((r) => r.glob.startsWith("*/") ? value.includes(r.glob.slice(1, -1)) : value.startsWith(r.glob.slice(0, -1)));
}

// ../findeverything-service-20261020/src/engine.ts
import { createHash as createHash2, randomUUID as randomUUID3 } from "crypto";
import { Transform } from "stream";
import { pipeline, finished } from "stream/promises";

// ../findeverything-service-20261020/src/file-intent.ts
function fileIntent(text) {
  if (!/\b(pdfs?|bilder|fotos?|images?|photos?|videos?|dokumente|documents?|archive|archives?|dateien|files?|favoriten|favorites|favorisiert\w*)\b/i.test(text))
    return;
  const fields = new Map;
  const put = (key, value) => {
    if (fields.has(key))
      throw new Error(`Use one ${key} condition per natural-language clause`);
    fields.set(key, value);
  };
  const encoded = '"(?:\\\\.|[^"\\\\])*"';
  let value = text.replace(new RegExp("\\b(?:im Ordner|in folder|in)\\s+(" + encoded + ")", "gi"), (_, q) => {
    const folder = JSON.parse(q);
    if (!folder.startsWith("/") && !folder.startsWith("~/"))
      throw new Error("Use an absolute folder path or ~/ inside a file clause");
    put("in", JSON.stringify(folder));
    return " ";
  }).replace(new RegExp("\\b(?:mit (?:dem )?Namen|named)\\s+(" + encoded + ")", "gi"), (_, q) => {
    const name = JSON.parse(q);
    if (!name || name.includes("/"))
      throw new Error("Use a filename fragment without /");
    put("name", JSON.stringify(name));
    return " ";
  });
  const folders = { downloads: "Downloads", dokumente: "Documents", dokumenten: "Documents", documents: "Documents", desktop: "Desktop", schreibtisch: "Desktop", bilder: "Pictures", pictures: "Pictures", musik: "Music", music: "Music" };
  value = value.replace(/\b(?:in|im)(?: meinen| den| the)?\s+(downloads|dokumenten?|documents|desktop|schreibtisch|bilder|pictures|musik|music)(?:[- ]ordner)?\b/gi, (_, folder) => {
    put("in", JSON.stringify("~/" + folders[folder.toLowerCase()]));
    return " ";
  });
  const groups = [[/\bpdfs?\b/gi, "ext:pdf"], [/\b(bilder|fotos?|images?|photos?)\b/gi, "type:image"], [/\bvideos?\b/gi, "type:video"], [/\b(dokumente|documents?)\b/gi, "type:doc"], [/\b(archive|archives?)\b/gi, "type:zip"]];
  const selected = new Set;
  for (const [pattern, filter] of groups)
    value = value.replace(pattern, () => {
      selected.add(filter);
      return " ";
    });
  if (selected.size > 1)
    throw new Error("Use one file group per clause; use ext:pdf;png for alternatives");
  value = value.replace(/\b(favoriten|favorites|favorisiert\w*)\b/gi, () => {
    if (!fields.has("favorites"))
      put("favorites", "true");
    return " ";
  });
  value = value.toLowerCase().replace(/(?:^|\s)(gr\u00F6\u00DFer als|groesser als|\u00FCber|ueber|larger than|over|mindestens|at least|kleiner als|unter|smaller than|under|h\u00F6chstens|hoechstens|at most)\s*(\d+(?:[.,]\d+)?)\s*(bytes?|kb|kilobytes?|mb|megabytes?|gb|gigabytes?)\b/g, (_, phrase, n, unit) => {
    const op = /^(mindestens|at least)/.test(phrase) ? ">=" : /^(h\u00F6chstens|hoechstens|at most)/.test(phrase) ? "<=" : /^(gr\u00F6\u00DFer|groesser|\u00FCber|ueber|larger|over)/.test(phrase) ? ">" : "<";
    put("size", op + n.replace(",", ".") + { b: "b", k: "k", m: "m", g: "g" }[unit[0]]);
    return " ";
  }).replace(/\b(?:(?:aus|in) den letzten|die letzten|letzte[n]?|(?:from )?the last|last)\s+(\d+)\s+(?:tagen?|days?)\b/g, (_, n) => {
    if (Number(n) < 1 || Number(n) > 365000)
      throw new Error("Use a day range from 1 to 365000");
    put("dm", Number(n) + "d");
    return " ";
  });
  const sorts = [[/\b(gr\u00F6\u00DFte zuerst|groesste zuerst|largest first)\b/g, "big"], [/\b(kleinste zuerst|smallest first)\b/g, "small"], [/\b(neueste zuerst|newest first)\b/g, "new"], [/(?:^|\s)(\u00E4lteste zuerst|aelteste zuerst|oldest first)\b/g, "old"], [/\b(nach namen|by name)\b/g, "name"]];
  for (const [pattern, sort] of sorts)
    value = value.replace(pattern, () => {
      put("sort", sort);
      return " ";
    });
  if (/[<>:=;"\x00-\x1f]/.test(value) || /(?:^|\s)(gr\u00F6\u00DFer|groesser|\u00FCber|ueber|kleiner|unter|mindestens|h\u00F6chstens|hoechstens|larger|smaller|under|over|least|most|ordner|folder)\b/.test(value))
    throw new Error("Unsupported file condition; try (PDFs gr\xF6\xDFer als 10 MB) or explicit search filters");
  const literal = value.replace(/\b(suche|finde|zeige|mir|bitte|alle|meine[nr]?|als|mit|aus|den|der|die|dem|und|dateien|files?|find|show|me|please|all|my|from|the|and)\b/g, " ").replace(/[,.!?]/g, " ").replace(/\s+/g, " ").trim();
  return [...selected, ...["favorites", "in", "name", "size", "dm", "sort"].flatMap((k) => fields.has(k) ? [k + ":" + fields.get(k)] : []), ...literal ? [JSON.stringify(literal)] : []].join(" ");
}

// ../findeverything-service-20261020/src/smart-query.ts
var MEDIA_FIELDS = {
  duration: "duration",
  length: "duration",
  channels: "channels",
  samplerate: "sampleRate",
  bitrate: "bitrate",
  width: "width",
  height: "height"
};
function normalizeQuery(input) {
  if (/[\x01\x02]/.test(input))
    throw new Error("Reserved control characters in query");
  const quoted = [];
  const clauses = [];
  let unquoted = input.replace(/"(?:\\.|[^"\\\n])*"/g, (s) => `\x01${quoted.push(s) - 1}\x01`);
  unquoted = unquoted.replace(/\(([^()]*)\)/g, (_, text) => `\x02${clauses.push(translateIntent(text.replace(/\u0001(\d+)\u0001/g, (_, n) => quoted[Number(n)]))) - 1}\x02`);
  if (/[()]/.test(unquoted))
    throw new Error("Use one level of balanced parentheses for natural language; quote literal parentheses");
  unquoted = unquoted.replace(/\u0002(\d+)\u0002/g, (_, n) => clauses[Number(n)]);
  input = unquoted.replace(/\u0001(\d+)\u0001/g, (_, n) => quoted[Number(n)]);
  const sentence = input.match(/^(?:(?:suche|finde|zeig(?:e)?(?: mir)?)\s+)?(?:alle?\s+)?(?:meine?\s+)?(?:sounds?|audios?|samples?|kl\u00E4nge|sounddateien)(?:\s+die)?\s+(?:unter|k\u00FCrzer als|kuerzer als|weniger als)\s*(\d+(?:[.,]\d+)?)\s*(ms|millisekunden?|s|sekunden?)(?:\s+(?:lang sind|gehen|sind))?[.!?]?$/i);
  if (sentence)
    return `type:audio duration:<${sentence[1].replace(",", ".")}${sentence[2].toLowerCase().startsWith("m") ? "ms" : "s"}`;
  return input.replace(/\b(audio|video|image|doc|code):(?=\s|$)/gi, "type:$1");
}
function translateIntent(text) {
  if (!text.trim() || text.length > 512 || /[\x00-\x1f]/.test(text))
    throw new Error("Natural-language clauses must contain 1\u2013512 characters");
  const files = fileIntent(text);
  if (files !== undefined)
    return files;
  let value = text.toLowerCase().replace(/lasersounds?|laserkl\u00E4nge|laserklange/g, "laser sound");
  const filters = [];
  value = value.replace(/(?:unter|k\u00FCrzer als|kuerzer als|weniger als|under|shorter than|\u00FCber|ueber|l\u00E4nger als|laenger als|over|longer than)\s*(\d+(?:[.,]\d+)?)\s*(millisekunden?|ms|sekunden?|seconds?|secs?|s|minuten?|minutes?|mins?)/g, (s, n, unit) => {
    const op = /^(\u00FCber|ueber|l\u00E4nger|laenger|over|longer)/.test(s) ? ">" : "<";
    filters.push(`duration:${op}${n.replace(",", ".")}${/^(ms|milli)/.test(unit) ? "ms" : /^(min)/.test(unit) ? "m" : "s"}`);
    return " ";
  });
  if (/\b(kurz\w*|short)\b/.test(value) && !filters.length)
    filters.push("duration:<1s");
  const words = {
    d\u{fc}ster: "dark eerie",
    d\u{fc}stere: "dark eerie",
    d\u{fc}steren: "dark eerie",
    duester: "dark eerie",
    duestere: "dark eerie",
    dunkel: "dark",
    dunkle: "dark",
    dunklen: "dark",
    unheimlich: "eerie",
    unheimliche: "eerie",
    hell: "bright",
    helle: "bright",
    hellen: "bright",
    lang: "long",
    lange: "long",
    langen: "long",
    metallisch: "metallic",
    metallische: "metallic",
    metallischen: "metallic",
    tief: "deep",
    tiefe: "deep",
    tiefen: "deep",
    hoch: "high pitched",
    hohe: "high pitched",
    hohen: "high pitched",
    weich: "soft",
    weiche: "soft",
    hart: "hard",
    harte: "hard",
    warm: "warm",
    warme: "warm",
    warmer: "warm",
    warmen: "warm",
    kalt: "cold",
    kalte: "cold",
    kalten: "cold",
    futuristisch: "futuristic",
    futuristische: "futuristic",
    futuristischer: "futuristic",
    futuristischen: "futuristic",
    elektronisch: "electronic",
    elektronische: "electronic",
    elektronischen: "electronic",
    aggressiv: "aggressive",
    aggressive: "aggressive",
    leise: "quiet",
    laut: "loud",
    laute: "loud",
    sanft: "gentle",
    sanfte: "gentle",
    verzerrt: "distorted",
    verzerrte: "distorted",
    schuss: "gunshot",
    sch\u{fc}sse: "gunshots",
    schussger\u{e4}usche: "gunshots",
    klick: "click",
    klicks: "clicks",
    piepsen: "beep",
    rauschen: "noise",
    explosion: "explosion",
    explosionen: "explosions",
    schritte: "footsteps",
    regen: "rain",
    wasser: "water",
    wind: "wind",
    hund: "dog",
    bellen: "barking",
    katze: "cat",
    vogel: "bird",
    v\u{f6}gel: "birds",
    klavier: "piano",
    trommel: "drum",
    drums: "drums",
    hundebellen: "dog barking",
    katzenmiauen: "cat meowing",
    vogelgezwitscher: "birds chirping",
    tastaturklicken: "keyboard typing",
    meeresrauschen: "ocean waves",
    windrauschen: "wind blowing",
    donnergrollen: "thunder rumbling",
    fu\u{df}schritte: "footsteps",
    fusschritte: "footsteps",
    ger\u{e4}usch: "sound effect",
    ger\u{e4}usche: "sound effects",
    klang: "sound",
    kl\u{e4}nge: "sounds",
    sounds: "sound effect",
    sound: "sound effect",
    stereo: "",
    mono: "",
    kurz: "",
    kurze: "",
    kurzen: "",
    suche: "",
    finde: "",
    zeige: "",
    mir: "",
    alle: "",
    meine: "",
    die: "",
    sind: "",
    gehen: "",
    bitte: "",
    und: "and",
    mit: "with",
    ohne: "without",
    ein: "",
    eine: "",
    einen: ""
  };
  if (/\bstereo\b/.test(value))
    filters.push("channels:2");
  if (/\bmono\b/.test(value))
    filters.push("channels:1");
  let description = value.replace(/[,;.!?]/g, " ").split(/\s+/).map((w) => words[w] ?? w).join(" ").replace(/["\\\x01]/g, " ").replace(/\s+/g, " ").trim();
  if (/^(sound effects?|sounds?|audios?|samples?)$/.test(description))
    description = "";
  return ["type:audio", ...filters, ...description ? [`sound:"${description}"`] : []].join(" ");
}
function soundPlan(description) {
  let anchor = description.replace(/\b(dark|eerie|bright|long|short|warm|cold|metallic|deep|high pitched|soft|hard|futuristic|electronic|aggressive|quiet|loud|gentle|distorted)\b/g, " ").replace(/\s+/g, " ").trim();
  if (/\blaser\b/.test(anchor) && !/sword|saber|beam|continuous/.test(anchor))
    anchor = "laser gun shot";
  if (!anchor || /^(sound effects?|sounds?)$/.test(anchor))
    anchor = description;
  return { description, anchor, anchorWeight: anchor === description ? 0 : 0.8 };
}
function numericFilters(key, value) {
  const field = MEDIA_FIELDS[key];
  const quantity = (s) => {
    const m = s.match(/^(\d+(?:\.\d+)?)(ms|s|secs?|seconds?|m|mins?|h|hours?|k|khz|hz|kbps|mbps)?$/i);
    if (!m)
      throw new Error(`Invalid ${key} filter: ${value}`);
    const unit = (m[2] || "").toLowerCase();
    const units = field === "duration" ? { "": 1, ms: 0.001, s: 1, sec: 1, secs: 1, second: 1, seconds: 1, m: 60, min: 60, mins: 60, h: 3600, hour: 3600, hours: 3600 } : field === "sampleRate" ? { "": 1, hz: 1, k: 1000, khz: 1000 } : field === "bitrate" ? { "": 1, k: 1000, kbps: 1000, mbps: 1e6 } : { "": 1 };
    if (!(unit in units))
      throw new Error(`Invalid unit for ${key}: ${unit}`);
    const n = Number(m[1]) * units[unit];
    if (!Number.isFinite(n) || n > 1000000000000 || (field === "channels" || field === "width" || field === "height") && (!Number.isInteger(n) || n < 1))
      throw new Error(`Invalid ${key} filter: ${value}`);
    return n;
  };
  const range = value.split("..");
  if (range.length === 2) {
    const low = quantity(range[0]), high = quantity(range[1]);
    if (low > high)
      throw new Error(`Invalid ${key} range`);
    return [{ field, op: ">=", value: low }, { field, op: "<=", value: high }];
  }
  const m = value.match(/^(<=|>=|<|>|=)?(.+)$/);
  if (!m)
    throw new Error(`Invalid ${key} filter`);
  return [{ field, op: m[1] || "=", value: quantity(m[2]) }];
}
var QUERY_HELP = {
  fileIntent: { examples: ["(PDFs gr\xF6\xDFer als 10 MB)", "(Bilder in Downloads)", "(Dateien aus den letzten 7 Tagen)", "(favorisierte PDFs mindestens 1,5 MB)", '(Dateien mit Namen "Q4 Bericht")'], notes: "Parentheses opt into bounded local rules for file groups, size, rolling day ranges, favorites, folders and sorting. No model call. Inspect normalizedQuery. Plain text and quoted literal parentheses retain their existing meaning. Size/date predicates only match known cached properties; unsupported or conflicting conditions are rejected." },
  favorites: { commands: ["fe favorites list --json", "fe favorites add /absolute/file.wav", "fe favorites remove /absolute/file.wav"], filters: ["favorites:true ext:wav", "is:favorite size:1m..10m", "view:working", "view:all", "omit:system;generated;hidden"], notes: "Favorites use the native app shared pins.json. Visibility filters do not remove indexed paths. The native app hides system/generated folders by default; CLI searches keep all paths unless explicitly filtered." },
  columnFilters: { sorts: ["name", "name-desc", "path", "path-desc", "big", "small", "new", "old"], examples: ['name:"laser blast"', 'in:"/Users/me/My Sounds" ext:wav;mp3', "size:=0", "size:1m..10m", "dm:14d"], notes: "Column filters combine across the index before pagination. Size ranges include both endpoints. Explicit sort also orders semantic candidates; omit sort to keep acoustic ranking." },
  examples: ["engine ext:ts sort:name", "ext:pdf dm:week sort:new", "size:>100m sort:big", "(kurze d\xFCstere Lasersounds)", "(Lasersounds unter 500 ms) ext:wav", 'sound:"dark eerie laser sound effect" duration:<1s', "audio: duration:<1s", "alle meine sounds die unter 1 sekunde gehen", "audio: duration:100ms..1s channels:1", "audio: samplerate:>=44.1k", "image: width:>=1920", "engine ext:ts !test"],
  mediaFields: Object.keys(MEDIA_FIELDS),
  notes: 'Filename/path searches count the whole indexed snapshot and return stable pages. sort:name|path|new|old|big|small applies globally; size/date require fe properties --index NAME. fe prepare --index NAME builds the accelerator from saved paths without a folder traversal. Pass nextOffset as offset and retain snapshotId. Index gaps, changed settings and unknown properties keep complete false. Parentheses opt into a deterministic German/English audio dictionary: kurz means duration:<1s. Inspect normalizedQuery. sound:"description" ranks cached local CLAP audio, without query-time decoding. Semantic recall is approximate. Setup: fe semantic setup; analyze explicitly with fe semantic index. Media fields require fe enrich --index NAME. No file-content index.'
};

// ../findeverything-service-20261020/src/delta.ts
import { Database } from "bun:sqlite";
import * as fs3 from "fs";
import * as path3 from "path";
var livePath = () => path3.join(INDEX_DIR, "live.sqlite");
function baseStamp(index) {
  const s = fs3.statSync(indexPathFor(index));
  return `${s.mtimeMs}:${s.size}`;
}
function openLive() {
  const db = new Database(livePath(), { create: true });
  db.exec(`PRAGMA busy_timeout=1000; PRAGMA cache_size=-4096;
    CREATE TABLE IF NOT EXISTS scopes (name TEXT PRIMARY KEY,stamp TEXT,revision INTEGER DEFAULT 0,problem TEXT,pid INTEGER,lastChange TEXT);
    CREATE TABLE IF NOT EXISTS changes (scope TEXT,path TEXT,present INTEGER,tree INTEGER,revision INTEGER,PRIMARY KEY(scope,path));
    CREATE TABLE IF NOT EXISTS streams (root TEXT PRIMARY KEY,uuid TEXT,cursor TEXT);
    CREATE TABLE IF NOT EXISTS jobs (scope TEXT,path TEXT,failures INTEGER DEFAULT 0,retryAt REAL DEFAULT 0,PRIMARY KEY(scope,path));`);
  if (!db.query("PRAGMA table_info(jobs)").all().some((c) => c.name === "failures"))
    db.exec("ALTER TABLE jobs ADD COLUMN failures INTEGER DEFAULT 0; ALTER TABLE jobs ADD COLUMN retryAt REAL DEFAULT 0;");
  return db;
}
function liveStatus(index) {
  if (!fs3.existsSync(livePath()))
    return { watching: false, revision: 0, problem: null };
  const db = new Database(livePath(), { readonly: true });
  db.exec("PRAGMA busy_timeout=1000; PRAGMA cache_size=-4096;");
  try {
    const row = db.query("SELECT * FROM scopes WHERE name=? AND stamp=?").get(index, baseStamp(index));
    if (!row)
      return { watching: false, revision: 0, problem: null };
    let watching = false, statusUnknown = false;
    try {
      process.kill(row.pid, 0);
      watching = row.pid > 0;
    } catch (e) {
      if (e.code === "EPERM")
        statusUnknown = true;
      else if (e.code !== "ESRCH")
        throw e;
    }
    return {
      watching,
      statusUnknown,
      revision: row.revision,
      problem: row.problem,
      lastChange: row.lastChange,
      pending: db.query("SELECT count(*) AS n FROM jobs WHERE scope=?").get(index).n
    };
  } finally {
    db.close();
  }
}
function deltaFor(index) {
  const exact = new Map, trees = new Map;
  let revision = 0;
  if (fs3.existsSync(livePath())) {
    const db = new Database(livePath(), { readonly: true });
    db.exec("PRAGMA busy_timeout=1000; PRAGMA cache_size=-4096;");
    try {
      const row = db.query("SELECT revision FROM scopes WHERE name=? AND stamp=?").get(index, baseStamp(index));
      if (row) {
        revision = row.revision;
        for (const r of db.query("SELECT path,present,tree,revision FROM changes WHERE scope=?").all(index)) {
          exact.set(r.path, r);
          if (r.tree)
            trees.set(r.path.replace(/\/$/, ""), r.revision);
        }
      }
    } finally {
      db.close();
    }
  }
  const visible = (p, base = false) => {
    p = p.replace(/\/$/, "") || "/";
    const own = exact.get(p);
    if (base && own)
      return false;
    let current = p;
    while (current !== path3.dirname(current)) {
      current = path3.dirname(current);
      if ((trees.get(current) || 0) > (own?.revision || 0))
        return false;
    }
    return own ? !!own.present : true;
  };
  return { revision, visible, additions: [...exact].filter(([p, r]) => r.present && visible(p)).map(([p]) => p).sort() };
}

// ../findeverything-service-20261020/src/file-display.ts
function humanBytes(n) {
  if (n === undefined)
    return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

// ../findeverything-service-20261020/src/engine.ts
var HOME = os3.homedir();
var IS_MAC = process.platform === "darwin";
var INDEX_DIR = process.env.FE_DATA_DIR || path4.join(HOME, ".cache", "hypersearch");
var BIN_DIRS = [
  path4.join(HOME, "Library/Application Support/FindEverything/bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  path4.join(HOME, ".local", "bin"),
  path4.join(HOME, "bin")
];
var findBin = (name) => {
  for (const d of BIN_DIRS) {
    const p = path4.join(d, name);
    if (fs4.existsSync(p))
      return p;
  }
  return name;
};
var FD = process.env.FE_FD || findBin("fd");
var FZF = findBin("fzf");
var RG = findBin("rg");
var OPEN_CMD = IS_MAC ? findBin("open") : findBin("xdg-open");
var BASE_EXCLUDES = [
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  ".Trash",
  ".DS_Store",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".cache",
  ".npm",
  ".npx",
  ".bun",
  ".yarn",
  ".pnpm-store",
  ".cargo",
  ".cargo-target",
  ".rustup",
  ".pub-cache",
  ".dartServer",
  ".gem",
  ".gradle",
  ".m2",
  ".cocoapods",
  "Pods",
  "DerivedData",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "target",
  ".venv",
  ".venv*",
  ".venvs",
  "venv",
  ".tox",
  "site-packages",
  ".conda",
  ".pyenv",
  ".nvm",
  ".volta",
  ".deno",
  ".local",
  ".terraform",
  ".serverless",
  ".vercel",
  ".composer",
  ".nuget",
  ".gg",
  ".gemini",
  ".cmux-snapshots",
  ".orbstack",
  ".lmstudio",
  "Library",
  "go/pkg"
];
var ALL_EXCLUDES = [
  "System",
  "dev",
  "net",
  "Volumes",
  "cores",
  "private/var",
  "proc",
  "sys",
  "run",
  "snap",
  "boot"
];
var SCOPES = [
  "home",
  "downloads",
  "documents",
  "applications",
  "all",
  "custom"
];
function effectiveOptions(scope, opts = {}) {
  validateName(scope);
  const saved = BUILTIN_SCOPES.includes(scope) ? undefined : profile(scope);
  if (!BUILTIN_SCOPES.includes(scope) && !saved && !opts.paths)
    throw new Error(`Unknown index: ${scope}`);
  const result = { includeHidden: true, includeIgnored: false, indexMaxAgeMinutes: "60", ...saved, ...opts };
  const age = Number(result.indexMaxAgeMinutes);
  if (!Number.isFinite(age) || age < 1 || age > 10080)
    throw new Error("Index max age must be 1\u201310080 minutes");
  return result;
}
function scopePaths(scope, opts) {
  opts = effectiveOptions(scope, opts);
  if (opts.paths?.length)
    return opts.paths;
  const dirs = (() => {
    switch (scope) {
      case "home":
        return [HOME];
      case "downloads":
        return [path4.join(HOME, "Downloads")];
      case "documents":
        return [path4.join(HOME, "Documents")];
      case "applications":
        return IS_MAC ? ["/Applications", path4.join(HOME, "Applications")] : [
          "/usr/share/applications",
          path4.join(HOME, ".local/share/applications")
        ];
      case "all":
        return ["/"];
      case "custom":
        return (opts.customSearchPaths || "").split(",").map((s) => s.trim()).filter(Boolean);
      default:
        return opts.paths || [];
    }
  })();
  return dirs.filter((d) => d === "/" || fs4.existsSync(d));
}
var indexPathFor = (scope) => path4.join(INDEX_DIR, `index-${validateName(scope)}.txt`);
var metaPathFor = (scope) => path4.join(INDEX_DIR, `index-${validateName(scope)}.json`);
var signature = (scope, opts) => createHash2("sha256").update(JSON.stringify([
  2,
  scopePaths(scope, opts),
  opts.includeHidden,
  opts.includeIgnored,
  opts.extraExcludes || "",
  BASE_EXCLUDES
])).digest("hex");
var INDEX_TIMEOUT_MS = 120000;
var inFlight = new Map;
var activeChildren = new Set;
function track(child) {
  activeChildren.add(child);
  child.once("close", () => activeChildren.delete(child));
  return child;
}
function stopChildren() {
  for (const child of activeChildren)
    child.kill("SIGKILL");
}
function rebuildIndex(scope, opts) {
  opts = effectiveOptions(scope, opts);
  const file = indexPathFor(scope);
  const pending = inFlight.get(file);
  if (pending)
    return pending;
  const job = (async () => {
    const scanStartedAt = new Date().toISOString();
    fs4.mkdirSync(INDEX_DIR, { recursive: true, mode: 448 });
    const lock = `${file}.lock`;
    const release = acquireLock(lock);
    const tmp = `${file}.${randomUUID3()}.tmp`;
    try {
      const dirs = scopePaths(scope, opts);
      if (dirs.length === 0)
        throw new Error(`No folders configured for ${scope}; use fe index --path FOLDER --name NAME`);
      for (const dir of dirs)
        if (!fs4.statSync(dir).isDirectory())
          throw new Error(`Not a folder: ${dir}`);
      const excludes = [
        ...BASE_EXCLUDES,
        ...(opts.extraExcludes || "").split(",").map((s) => s.trim()).filter(Boolean),
        ...scope === "all" ? ALL_EXCLUDES : []
      ];
      const args = ["--absolute-path", "--color=never", "--print0", "--threads", "2"];
      if (opts.includeHidden)
        args.push("--hidden");
      if (opts.includeIgnored)
        args.push("--no-ignore");
      for (const e of excludes)
        args.push("--exclude", e);
      args.push("", ...dirs);
      const out = fs4.createWriteStream(tmp, { mode: 384 });
      const child = track(spawn(FD, args));
      child.stdout.setEncoding("utf8");
      let stderr = "", pending = "", count = 0, bytes = 0, skipped = 0;
      child.stderr.on("data", (d) => {
        stderr = (stderr + d).slice(-2000);
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), INDEX_TIMEOUT_MS);
      const normalizer = new Transform({ transform(chunk, _encoding, done) {
        pending += chunk.toString("utf8");
        const entries = pending.split("\x00");
        pending = entries.pop();
        if (pending.length > 1024 * 1024)
          return done(new Error("Path exceeds index limit"));
        const valid = entries.filter((p) => {
          if (/[\r\n]/.test(p)) {
            skipped++;
            return false;
          }
          return p.length > 0;
        });
        const text = valid.length ? valid.join(`
`) + `
` : "";
        count += valid.length;
        bytes += Buffer.byteLength(text);
        if (bytes > 1024 ** 3)
          return done(new Error("Index exceeds 1 GiB; use a smaller folder or additional excludes"));
        done(null, text);
      } });
      const exited = new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`fd exited ${code}: ${stderr || "scan failed or timed out"}`)));
      });
      try {
        await Promise.all([pipeline(child.stdout, normalizer, out), exited]);
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null)
          child.kill("SIGKILL");
      }
      fs4.renameSync(tmp, file);
      const metaTmp = `${metaPathFor(scope)}.${randomUUID3()}.tmp`;
      fs4.writeFileSync(metaTmp, JSON.stringify({ signature: signature(scope, opts), count, bytes, skipped, paths: dirs, scanStartedAt, indexedAt: new Date().toISOString() }), { mode: 384 });
      fs4.renameSync(metaTmp, metaPathFor(scope));
    } finally {
      fs4.rmSync(tmp, { force: true });
      release();
    }
  })().finally(() => inFlight.delete(file));
  inFlight.set(file, job);
  return job;
}
async function ensureIndex(scope, opts, force = false, _background = false, _snapshot = false) {
  opts = effectiveOptions(scope, opts);
  const file = indexPathFor(scope);
  if (!fs4.existsSync(INDEX_DIR))
    fs4.mkdirSync(INDEX_DIR, { recursive: true, mode: 448 });
  if (fs4.existsSync(file) && !force) {
    return file;
  }
  if (!force && !opts.paths?.length)
    throw new Error(`No saved index for ${scope}; create it explicitly with fe index --index ${scope}`);
  await rebuildIndex(scope, opts);
  return file;
}
function indexStatus() {
  return [...SCOPES.filter((s) => s !== "custom"), ...profiles().map((p) => p.name)].map((name) => {
    const file = indexPathFor(name);
    const stat = fs4.existsSync(file) ? fs4.statSync(file) : undefined;
    const meta = fs4.existsSync(metaPathFor(name)) ? JSON.parse(fs4.readFileSync(metaPathFor(name), "utf8")) : {};
    const opts = effectiveOptions(name);
    return {
      name,
      paths: scopePaths(name, opts),
      options: opts,
      exists: !!stat,
      bytes: stat?.size || 0,
      indexedAt: stat?.mtime.toISOString() || null,
      scanStartedAt: meta.scanStartedAt || null,
      count: meta.count ?? null,
      skipped: meta.skipped || 0,
      provenanceWarnings: Array.isArray(meta.provenanceWarnings) ? meta.provenanceWarnings : [],
      configurationChanged: !!stat && meta.signature !== signature(name, opts),
      stale: !stat || meta.signature !== signature(name, opts) || Date.now() - stat.mtimeMs > Number(opts.indexMaxAgeMinutes) * 60000
    };
  });
}
function snapshotDescription(scope, opts, count, bytes, provenanceWarnings = []) {
  const now = new Date().toISOString();
  return { signature: signature(scope, effectiveOptions(scope, opts)), count, bytes, skipped: 0, paths: scopePaths(scope, opts), scanStartedAt: now, indexedAt: now, provenanceWarnings };
}
var reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
var IN_ALIASES = {
  downloads: "Downloads",
  documents: "Documents",
  docs: "Documents",
  desktop: "Desktop",
  pictures: "Pictures",
  pics: "Pictures",
  music: "Music",
  movies: "Movies",
  applications: "Applications",
  apps: "Applications",
  projects: "Projects"
};
var TYPE_MACROS = {
  doc: "txt|md|pdf|rtf|odt|doc|docx|pages|tex|epub",
  image: "png|jpe?g|gif|webp|svg|heic|tiff?|bmp|ico",
  video: "mp4|m4v|mov|mkv|avi|webm|wmv|flv",
  audio: "mp3|wav|aac|flac|m4a|ogg|opus|aiff?|caf|wma",
  zip: "zip|tar|tgz|gz|bz2|xz|rar|7z",
  code: "py|js|ts|tsx|jsx|swift|rs|go|c|h|cpp|cc|mm|m|java|kt|rb|sh|zsh|pl|lua|sql|html|css|json|ya?ml|toml|xml",
  app: "app|dmg|pkg"
};
var SIZE_UNITS = {
  b: 1,
  k: 1 << 10,
  kb: 1 << 10,
  m: 1 << 20,
  mb: 1 << 20,
  g: 1 << 30,
  gb: 1 << 30
};
var DM_DAYS = {
  today: 1,
  yesterday: 2,
  week: 7,
  thisweek: 7,
  month: 31,
  thismonth: 31,
  year: 366,
  thisyear: 366
};
function parseQuery(q) {
  q = normalizeQuery(q);
  const pq = { fuzzy: [], constraints: [], mediaFilters: [] };
  q = q.replace(/sound:("(?:\\.|[^"\\\n])+")/g, (_, encoded) => {
    const description = JSON.parse(encoded);
    if (pq.semantic)
      throw new Error("Use one sound description per query");
    if (description.length > 512)
      throw new Error("Sound description exceeds 512 characters");
    pq.semantic = description;
    return " ";
  });
  const toks = q.match(/(?:[^\s"]|"(?:\\.|[^"\\])*")+/g) || [];
  if (q.replace(/(?:[^\s"]|"(?:\\.|[^"\\])*")+/g, "").trim())
    throw new Error("Unclosed quoted value");
  const unquote = (s) => {
    if (!s.startsWith('"'))
      return s;
    try {
      const value = JSON.parse(s);
      if (typeof value === "string")
        return value;
    } catch {
      throw new Error("Invalid quoted value");
    }
    throw new Error("Invalid quoted value");
  };
  if (toks.length + pq.fuzzy.length > 32)
    throw new Error("Use at most 32 search terms or filters");
  const inTarget = (v) => {
    const lv = v.toLowerCase();
    if (IN_ALIASES[lv])
      return `/${IN_ALIASES[lv]}/`;
    if (v.startsWith("/") || v.startsWith("~"))
      return v.startsWith("~") ? HOME + v.slice(1) : v;
    return `/${lv}/`;
  };
  for (let i = 0;i < toks.length; i++) {
    const tok = toks[i];
    if (tok.startsWith('"')) {
      pq.fuzzy.push("'" + unquote(tok));
      continue;
    }
    if ((tok === "in" || tok === "in:") && toks[i + 1]) {
      const literal = inTarget(unquote(toks[++i]));
      pq.constraints.push({ pattern: reEsc(literal), literal, negate: false });
      continue;
    }
    if (tok.startsWith("!") && tok.length > 1) {
      pq.constraints.push({ pattern: reEsc(tok.slice(1)), literal: tok.slice(1), negate: true });
      continue;
    }
    if (tok.startsWith("*.") && /^[\w-]+$/.test(tok.slice(2))) {
      pq.constraints.push({ pattern: `\\.${tok.slice(2)}$`, suffixes: ["." + tok.slice(2).toLowerCase()], negate: false });
      continue;
    }
    const m = tok.match(/^([a-z]+):(.+)$/i);
    if (m) {
      const k = m[1].toLowerCase();
      const v = unquote(m[2]);
      const lv = v.toLowerCase();
      if (MEDIA_FIELDS[k]) {
        pq.mediaFilters.push(...numericFilters(k, lv));
        continue;
      }
      if (k === "favorites" || k === "fav" || (k === "is" || k === "type") && ["favorite", "favorites"].includes(lv)) {
        if (["true", "yes", "1", "favorite", "favorites"].includes(lv))
          pq.favorites = favoritePaths();
        else if (["false", "no", "0"].includes(lv))
          pq.favorites = undefined;
        else
          throw new Error("Use favorites:true or favorites:false");
        continue;
      }
      if (k === "view") {
        if (lv === "all")
          pq.omit = [];
        else if (lv === "working")
          pq.omit = ["system", "generated"];
        else
          throw new Error("Use view:working or view:all");
        continue;
      }
      if (k === "omit") {
        const kinds = lv.split(";");
        if (kinds.some((v) => !["system", "generated", "hidden"].includes(v)))
          throw new Error("Use omit:system;generated;hidden");
        pq.omit = [...new Set(kinds)];
        continue;
      }
      if (k === "ext") {
        const parts = lv.split(";").filter((e) => /^[\w-]+(\.[\w-]+)*$/.test(e));
        if (!parts.length || parts.length !== lv.split(";").length)
          throw new Error("Invalid extension filter");
        if (parts.length)
          pq.constraints.push({
            pattern: `\\.(${parts.map(reEsc).join("|")})$`,
            suffixes: parts.map((p) => "." + p),
            negate: false
          });
        continue;
      }
      if (k === "in") {
        const literal = inTarget(v);
        pq.constraints.push({ pattern: reEsc(literal), literal, negate: false });
        continue;
      }
      if (k === "name") {
        if (!v || v.includes("/"))
          throw new Error("Name filter needs a filename fragment without /");
        pq.constraints.push({ pattern: reEsc(v) + "[^/]*\\/?$", literal: v, field: "name", negate: false });
        continue;
      }
      if (k === "type" || k === "is" || k === "kind") {
        if (TYPE_MACROS[lv]) {
          pq.constraints.push({
            pattern: `\\.(${TYPE_MACROS[lv]})$`,
            suffixes: TYPE_MACROS[lv].split("|").flatMap((p) => {
              const m = p.match(/^(.*)([a-z])\?(.*)$/);
              return m ? [m[1] + m[3], m[1] + m[2] + m[3]] : [p];
            }).map((p) => "." + p),
            negate: false
          });
        } else if (lv === "hidden" || lv === "dot") {
          pq.constraints.push({ pattern: "/\\.", literal: "/.", negate: false });
        } else
          throw new Error("Unknown file type; use audio, video, image, doc, code, zip, app or hidden");
        continue;
      }
      if (k === "sort") {
        if (/^(name|name-desc|path|path-desc|new|old|big|small|size)$/.test(lv))
          pq.sort = lv === "size" ? "big" : lv;
        else
          throw new Error("Unknown sort; use name, name-desc, path, path-desc, new, old, big or small");
        continue;
      }
      if (k === "size") {
        const range = lv.match(/^(\d+(?:\.\d+)?)(b|kb?|mb?|gb?)?\.\.(\d+(?:\.\d+)?)(b|kb?|mb?|gb?)?$/);
        if (range) {
          const bytes = Number(range[1]) * SIZE_UNITS[range[2] || "b"], maxBytes = Number(range[3]) * SIZE_UNITS[range[4] || "b"];
          if (!Number.isFinite(bytes) || !Number.isFinite(maxBytes) || bytes > maxBytes)
            throw new Error("Invalid size range");
          pq.sizeFilter = { op: "range", bytes, maxBytes };
          continue;
        }
        const sm = lv.match(/^(>=|<=|>|<|=)?(\d+(?:\.\d+)?)(b|kb?|mb?|gb?)?$/);
        if (sm)
          pq.sizeFilter = {
            op: sm[1] || ">",
            bytes: parseFloat(sm[2]) * (SIZE_UNITS[sm[3] || "b"] || 1)
          };
        else
          throw new Error("Invalid size filter; use size:>10m, size:=0 or size:1m..10m");
        if (!Number.isFinite(pq.sizeFilter.bytes))
          throw new Error("Size exceeds supported range");
        continue;
      }
      if (k === "dm" || k === "modified") {
        if (DM_DAYS[lv])
          pq.dmFilter = { days: DM_DAYS[lv] };
        else {
          const dm = lv.match(/^(?:<|in)?(\d+)d$/);
          if (dm)
            pq.dmFilter = { days: parseInt(dm[1]) };
          else
            throw new Error("Invalid modified-date filter");
        }
        continue;
      }
    }
    if (tok.includes("|")) {
      const alts = tok.split("|").filter(Boolean).map(reEsc);
      if (alts.length > 1) {
        pq.constraints.push({ pattern: `(${alts.join("|")})`, alternatives: tok.split("|").filter(Boolean), negate: false });
        pq.fuzzy.push(tok);
        continue;
      }
    }
    pq.fuzzy.push(tok);
  }
  if (pq.fuzzy.length > 16)
    throw new Error("Use at most 16 search terms");
  return pq;
}
function rerank(paths, q) {
  const groups = parseQuery(q).fuzzy.map((t) => t.replace(/^'/, "").toLowerCase()).map((t) => t.split("|"));
  const seen = new Set;
  const nameHit = [];
  const rest = [];
  for (const p of paths) {
    if (seen.has(p))
      continue;
    seen.add(p);
    const base = path4.basename(p).toLowerCase();
    (groups.every((g) => g.some((alt) => base.includes(alt))) ? nameHit : rest).push(p);
  }
  return [...nameHit, ...rest];
}
function matchesSize(value, filter) {
  if (value == null)
    return false;
  if (!filter)
    return true;
  return filter.op === "range" ? value >= filter.bytes && value <= filter.maxBytes : filter.op === ">" ? value > filter.bytes : filter.op === "<" ? value < filter.bytes : filter.op === ">=" ? value >= filter.bytes : filter.op === "<=" ? value <= filter.bytes : value === filter.bytes;
}
function compareSearchProperties(a, b, sort) {
  const compare = (x, y) => x < y ? -1 : x > y ? 1 : 0, tie = compare(a.path, b.path);
  if (sort === "name" || sort === "name-desc")
    return (compare(path4.basename(a.path).toLowerCase(), path4.basename(b.path).toLowerCase()) || tie) * (sort === "name-desc" ? -1 : 1);
  if (sort === "path" || sort === "path-desc")
    return (compare((path4.dirname(a.path) + "/").toLowerCase(), (path4.dirname(b.path) + "/").toLowerCase()) || compare(path4.basename(a.path).toLowerCase(), path4.basename(b.path).toLowerCase()) || tie) * (sort === "path-desc" ? -1 : 1);
  const field = sort === "new" || sort === "old" ? "mtime" : "size", x = a[field], y = b[field];
  if (x == null || y == null)
    return x == null ? y == null ? tie : 1 : -1;
  return (x - y) * (sort === "new" || sort === "big" ? -1 : 1) || tie;
}
function openPath(p) {
  spawn(OPEN_CMD, [p], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

// ../findeverything-service-20261020/src/completions.ts
function completions(shell) {
  const commands = "search favorites index indexes status watch prepare combine properties enrich repair-media semantic query-help open reveal preview completions serve mcp help";
  if (shell === "bash")
    return `_fe() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" prev="\${COMP_WORDS[COMP_CWORD-1]}"
  case "$prev" in
    --index|--scope) COMPREPLY=( $(compgen -W "$(fe indexes --names 2>/dev/null)" -- "$cur") ) ;;
    --path) COMPREPLY=( $(compgen -d -- "$cur") ) ;;
    --preset) COMPREPLY=( $(compgen -W "project folder" -- "$cur") ) ;;
    --kind) COMPREPLY=( $(compgen -W "audio video image media" -- "$cur") ) ;;
    completions) COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") ) ;;
    *) COMPREPLY=( $(compgen -W "${commands} --index --path --name --preset --exclude --max-age --json --null --fresh --snapshot --socket --kind --max-files --seconds --idle-seconds --offset --query --hidden --include-ignored --replace --limit --port --help" -- "$cur") $(compgen -f -- "$cur") ) ;;
  esac
}
complete -o filenames -F _fe fe
`;
  if (shell === "zsh")
    return `#compdef fe
_fe() {
  local -a indexes
  indexes=(\${(f)"$(fe indexes --names 2>/dev/null)"})
  _arguments -s \\
    '1:command:(${commands})' \\
    '*--index[index name]:index:($indexes)' '*--scope[scope]:scope:($indexes)' \\
    '*--path[folder]:folder:_directories' '--name[saved index name]:name:' \\
    '--preset[defaults]:preset:(project folder)' '--limit[result limit]:count:' \\
    '*--exclude[exclude glob]:glob:' '--max-age[refresh age in minutes]:minutes:' \\
    '--json[JSON output]' '--null[NUL separated paths]' '--fresh[refresh before search]' \\
    '--hidden[include dotfiles]' '--no-hidden[exclude dotfiles]' '--include-ignored[include ignored files]' \\
    '--respect-ignore[honor ignore rules]' '--replace[update saved profile]' \\
    '--port[local API port]:port:' '--interval[watch debounce seconds]:seconds:' \\
    '--socket[private Unix socket]:socket:_files' '--snapshot[use existing snapshot]' '--live[automatic incremental updates]' \\
    '--kind[media kind]:kind:(audio video image media)' '--max-files[probe budget]:count:' \\
    '--seconds[enrichment time budget]:seconds:' '--idle-seconds[service idle timeout]:seconds:' \\
    '--offset[browse or filtered page offset]:offset:' '--query[sound analysis candidate query]:query:' \\
    '--help[help]' '--version[version]' '*:file:_files'
}
compdef _fe fe
`;
  if (shell === "fish")
    return `complete -c fe -f
complete -c fe -n '__fish_use_subcommand' -a '${commands}'
complete -c fe -l index -l scope -r -a '(fe indexes --names 2>/dev/null)'
complete -c fe -l path -r -a '(__fish_complete_directories)'
complete -c fe -l preset -r -a 'project folder'
complete -c fe -l kind -r -a 'audio video image media'
complete -c fe -n '__fish_seen_subcommand_from completions' -a 'bash zsh fish'
complete -c fe -l json -l null -l fresh -l hidden -l no-hidden -l include-ignored -l respect-ignore -l replace -l help -l version
complete -c fe -l snapshot
complete -c fe -l name -l exclude -l max-age -l limit -l port -l interval -l socket -l max-files -l seconds -l idle-seconds -l offset -l query -r
`;
  throw new Error("Shell must be bash, zsh or fish");
}

// ../findeverything-service-20261020/src/shell.ts
function shellCommand(args) {
  return args.map((value) => `'${value.replace(/'/g, "'\\''")}'`).join(" ");
}

// ../findeverything-service-20261020/src/services.ts
import * as http2 from "http";
import { randomBytes, timingSafeEqual } from "crypto";
import * as fs13 from "fs";

// ../findeverything-service-20261020/src/media.ts
import { Database as Database2 } from "bun:sqlite";
import * as fs6 from "fs";
import * as path6 from "path";
import { execFile } from "child_process";
import { promisify } from "util";

// ../findeverything-service-20261020/src/native-probe.ts
import { spawn as spawn2 } from "child_process";
import * as fs5 from "fs";
import * as path5 from "path";
class NativeProbe {
  child;
  pending;
  buffer = "";
  failed = false;
  binary = process.env.FE_MEDIA_PROBE || path5.join(HOME, "Applications/Find Everything.app/Contents/Helpers/fe-media-probe");
  used = 0;
  async read(file, timeout) {
    if (this.failed || this.binary === "off" || !fs5.existsSync(this.binary) || !/\.(mp3|wav|aiff?|m4a|aac|flac|caf)$/i.test(file))
      return;
    if (!this.child) {
      this.child = track(spawn2(this.binary, [], { stdio: ["pipe", "pipe", "pipe"] }));
      this.child.stderr.resume();
      this.child.stdin.on("error", (e) => this.fail(e));
      this.child.on("error", (e) => this.fail(e));
      this.child.on("exit", () => this.fail(new Error("Native media reader exited")));
      this.child.stdout.setEncoding("utf8");
      this.child.stdout.on("data", (chunk) => {
        this.buffer += chunk;
        if (this.buffer.length > 65536)
          return this.fail(new Error("Native metadata exceeds limit"));
        const end = this.buffer.indexOf(`
`);
        if (end < 0)
          return;
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        try {
          const data = JSON.parse(line);
          const waiter = this.pending;
          this.pending = undefined;
          waiter?.resolve(data);
        } catch (e) {
          this.fail(e);
        }
      });
    }
    const timer = setTimeout(() => this.fail(new Error("Native media reader timed out")), timeout);
    try {
      const data = await new Promise((resolve, reject) => {
        this.pending = { resolve, reject };
        this.child.stdin.write(JSON.stringify({ path: file }) + `
`);
      });
      if (data.error || !Number.isFinite(data.duration) || data.duration < 0 || !Number.isFinite(data.sampleRate) || data.sampleRate <= 0 || !Number.isInteger(data.channels) || data.channels < 1)
        return;
      this.used++;
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
  fail(error) {
    this.failed = true;
    this.child?.kill("SIGKILL");
    this.pending?.reject(error);
    this.pending = undefined;
  }
  close() {
    this.child?.kill("SIGKILL");
  }
}

// ../findeverything-service-20261020/src/media.ts
var exec = promisify(execFile);
var AUDIO = /\.(mp3|wav|aac|flac|m4a|ogg|opus|aiff?|caf|wma)$/i;
var VIDEO = /\.(mp4|m4v|mov|mkv|avi|webm|wmv|flv)$/i;
var IMAGE = /\.(png|jpe?g|gif|webp|heic|tiff?|bmp)$/i;
var MEDIA_PATTERN = "\\.(mp3|wav|aac|flac|m4a|ogg|opus|aiff?|caf|wma|mp4|m4v|mov|mkv|avi|webm|wmv|flv|png|jpe?g|gif|webp|heic|tiff?|bmp)$";
var mediaPath = (index) => path6.join(INDEX_DIR, `media-${validateName(index)}.sqlite`);
var stamp = (index) => {
  const s = fs6.statSync(indexPathFor(index));
  return `${s.mtimeMs}:${s.size}`;
};
var kind = (p) => AUDIO.test(p) ? "audio" : VIDEO.test(p) ? "video" : IMAGE.test(p) ? "image" : "unknown";
function openStore(index, readonly = false) {
  const db = new Database2(mediaPath(index), { readonly, create: !readonly });
  db.exec("PRAGMA busy_timeout=1000; PRAGMA cache_size=-8192; PRAGMA temp_store=MEMORY;");
  if (!readonly)
    db.exec(`CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY, kind TEXT NOT NULL, size INTEGER, mtime REAL, status TEXT NOT NULL DEFAULT 'pending',
    duration REAL, codec TEXT, sampleRate INTEGER, channels INTEGER, bitrate REAL, width INTEGER, height INTEGER, source TEXT, error TEXT
  ); CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  if (!readonly && !db.query("PRAGMA table_info(files)").all().some((c) => c.name === "source"))
    db.exec("ALTER TABLE files ADD COLUMN source TEXT");
  return db;
}
async function probe(file, native, remaining) {
  const t0 = performance.now();
  let metadata;
  try {
    metadata = await native.read(file, Math.min(1000, remaining / 2));
  } catch (e) {
    console.error(`fe: native reader unavailable; using ffprobe: ${e.message}`);
  }
  if (metadata)
    return [metadata.duration, metadata.codec, metadata.sampleRate, metadata.channels, null, null, null, "native-frames"];
  const task = exec(findBin("ffprobe"), [
    "-v",
    "error",
    "-max_alloc",
    "67108864",
    "-protocol_whitelist",
    "file,pipe",
    "-probesize",
    "1048576",
    "-analyzeduration",
    "1000000",
    "-threads",
    "1",
    "-show_entries",
    "format=duration,bit_rate:stream=codec_type,codec_name,duration,sample_rate,channels,width,height",
    "-of",
    "json",
    "-i",
    file
  ], { timeout: Math.max(1, Math.min(3000, remaining - (performance.now() - t0))), maxBuffer: 65536, killSignal: "SIGKILL", env: { ...process.env, OMP_NUM_THREADS: "1" } });
  track(task.child);
  const { stdout } = await task;
  const parsed = JSON.parse(stdout);
  const streams = parsed.streams || [];
  const stream = streams.find((s) => s.codec_type === (kind(file) === "audio" ? "audio" : "video")) || streams[0];
  if (!stream)
    throw new Error("No readable media stream");
  const number = (v) => {
    const n = Number(v);
    return v != null && Number.isFinite(n) && n >= 0 ? n : null;
  };
  if (kind(file) === "audio" && (!(number(parsed.format?.duration ?? stream.duration) > 0) || !(number(stream.sample_rate) > 0)))
    throw new Error("No valid audio duration/sample rate; container cannot be decoded reliably");
  return [number(parsed.format?.duration ?? stream.duration), stream.codec_name || null, number(stream.sample_rate), number(stream.channels), number(parsed.format?.bit_rate), number(stream.width), number(stream.height), "ffprobe-container"];
}
var READER_VERSION = "audio-metadata-v2";
function classify(file, size) {
  if (!size)
    return "empty";
  const fd = fs6.openSync(file, "r");
  try {
    const b = Buffer.alloc(4);
    fs6.readSync(fd, b, 0, 4, 0);
    if (b.readUInt32BE(0) === 333319)
      return "appledouble";
  } finally {
    fs6.closeSync(fd);
  }
}
async function repairMedia(index, maxFiles = 500, seconds = 60, changedPaths) {
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 1e4 || seconds < 1 || seconds > 300)
    throw new Error("Invalid repair budget");
  if (!fs6.existsSync(mediaPath(index)))
    return { index, inspected: 0, recovered: 0, failed: 0, excluded: 0, reused: 0, pending: 0 };
  const release = acquireLock(mediaPath(index) + ".lock"), native = new NativeProbe;
  const db = openStore(index), deadline = performance.now() + seconds * 1000;
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS attempts (canonical TEXT PRIMARY KEY,size INTEGER,mtime REAL,version TEXT,status TEXT,values_json TEXT,error TEXT);
      CREATE TABLE IF NOT EXISTS aliases (path TEXT PRIMARY KEY,canonical TEXT); CREATE INDEX IF NOT EXISTS aliases_target ON aliases(canonical);`);
    let paths;
    if (changedPaths) {
      paths = [...new Set(changedPaths.flatMap((p) => [p, ...db.query("SELECT path FROM aliases WHERE canonical=?").all(p).map((r) => r.path)]))];
      const soundsFile = path6.join(INDEX_DIR, `sound-${validateName(index)}.sqlite`);
      if (fs6.existsSync(soundsFile)) {
        const sounds = new Database2(soundsFile, { readonly: true });
        try {
          if (sounds.query("SELECT 1 FROM sqlite_master WHERE name='aliases'").get())
            paths = [...new Set([...paths, ...changedPaths.flatMap((p) => sounds.query("SELECT path FROM aliases WHERE canonical=?").all(p).map((r) => r.path))])];
        } finally {
          sounds.close();
        }
      }
      db.transaction(() => {
        for (const p of paths) {
          if (!fs6.existsSync(p)) {
            db.query("DELETE FROM files WHERE path=?").run(p);
            db.query("DELETE FROM aliases WHERE path=?").run(p);
          } else if (kind(p) !== "unknown" && fs6.statSync(p).isFile())
            db.query("INSERT OR IGNORE INTO files(path,kind) VALUES (?,?)").run(p, kind(p));
        }
      })();
    } else
      paths = db.query("SELECT path FROM files WHERE kind='audio' AND status<>'excluded' AND (status<>'ok' OR duration IS NULL) ORDER BY path").all().map((r) => r.path);
    const groups = new Map;
    for (const p of paths) {
      if (!db.query("SELECT path FROM files WHERE path=?").get(p))
        continue;
      let canonical;
      try {
        canonical = fs6.realpathSync(p);
      } catch {
        canonical = p;
      }
      const group = groups.get(canonical) || [];
      group.push(p);
      groups.set(canonical, group);
    }
    let inspected = 0, recovered = 0, failed = 0, excluded = 0, reused = 0, pending = 0;
    const reasons = {};
    const update = db.query("UPDATE files SET size=?,mtime=?,status=?,duration=?,codec=?,sampleRate=?,channels=?,bitrate=?,width=?,height=?,source=?,error=? WHERE path=?");
    const writes = [];
    const flush = () => {
      if (writes.length)
        db.transaction(() => {
          for (const write of writes)
            write();
        })();
      writes.length = 0;
    };
    for (const [canonical, aliases] of groups) {
      if (performance.now() >= deadline - 50) {
        pending += aliases.length;
        continue;
      }
      let stat;
      try {
        stat = fs6.statSync(canonical);
        if (!stat.isFile())
          throw new Error("Not a file");
      } catch {
        db.transaction(() => {
          for (const p of aliases)
            db.query("UPDATE files SET status='missing',duration=NULL,error='File missing' WHERE path=? AND status<>'missing'").run(p);
        })();
        failed += aliases.length;
        continue;
      }
      const old = db.query("SELECT * FROM attempts WHERE canonical=?").get(canonical);
      if (changedPaths && !old && aliases.every((p) => {
        const row = db.query("SELECT size,mtime,status,duration FROM files WHERE path=?").get(p);
        return row?.size === stat.size && row.mtime === stat.mtimeMs && row.status === "ok" && row.duration != null;
      })) {
        reused += aliases.length;
        continue;
      }
      if (old?.size === stat.size && old.mtime === stat.mtimeMs && old.version === READER_VERSION) {
        reused += aliases.length;
        db.transaction(() => {
          for (const p of aliases) {
            const row = db.query("SELECT size,mtime,status,duration FROM files WHERE path=?").get(p);
            if (row.size !== stat.size || row.mtime !== stat.mtimeMs || row.status !== old.status || row.duration !== JSON.parse(old.values_json)[0])
              update.run(stat.size, stat.mtimeMs, old.status, ...JSON.parse(old.values_json), old.error, p);
          }
        })();
        continue;
      }
      if (inspected >= maxFiles) {
        pending += aliases.length;
        continue;
      }
      inspected++;
      let status = "ok", values = Array(8).fill(null), error = null;
      try {
        const special = classify(canonical, stat.size);
        if (special) {
          status = special === "appledouble" ? "excluded" : "failed";
          error = special;
        } else
          values = await probe(canonical, native, deadline - performance.now());
        const after = fs6.statSync(canonical);
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
          pending += aliases.length;
          continue;
        }
      } catch (e) {
        if (e.code === "ENOENT")
          throw new Error("ffprobe or the audio file is unavailable; retry after resolving it");
        status = "failed";
        error = String(e.stderr || e.message).slice(-400);
      }
      writes.push(() => {
        db.query("INSERT OR REPLACE INTO attempts VALUES (?,?,?,?,?,?,?)").run(canonical, stat.size, stat.mtimeMs, READER_VERSION, status, JSON.stringify(values), error);
        for (const p of aliases) {
          update.run(stat.size, stat.mtimeMs, status, ...values, error, p);
          db.query("INSERT INTO aliases VALUES (?,?) ON CONFLICT(path) DO UPDATE SET canonical=excluded.canonical WHERE canonical<>excluded.canonical").run(p, canonical);
        }
      });
      if (writes.length >= 64)
        flush();
      if (status === "ok")
        recovered += aliases.length;
      else if (status === "excluded")
        excluded += aliases.length;
      else
        failed += aliases.length;
      if (error)
        reasons[error] = (reasons[error] || 0) + aliases.length;
    }
    flush();
    return { index, paths: paths.length, unique: groups.size, inspected, recovered, failed, excluded, reused, pending, reasons, reader: READER_VERSION };
  } finally {
    native.close();
    db.close();
    release();
  }
}
async function enrichMedia(index, maxFiles = 500, seconds = 60, mediaKind = "audio") {
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 1e4 || !Number.isFinite(seconds) || seconds < 1 || seconds > 300 || !["audio", "video", "image", "media"].includes(mediaKind))
    throw new Error("Invalid enrichment budget or kind");
  fs6.mkdirSync(INDEX_DIR, { recursive: true, mode: 448 });
  const release = acquireLock(mediaPath(index) + ".lock");
  const deadline = performance.now() + seconds * 1000;
  const native = new NativeProbe;
  let db;
  try {
    const currentStamp = stamp(index), delta = deltaFor(index);
    db = openStore(index);
    const oldStamp = db.query("SELECT value FROM meta WHERE key='indexStamp'").get()?.value;
    if (oldStamp !== currentStamp || (db.query("SELECT value FROM meta WHERE key='deltaRevision'").get()?.value || "0") !== String(delta.revision)) {
      let output = "";
      try {
        output = (await exec(RG, ["-i", "--no-filename", "--", MEDIA_PATTERN, indexPathFor(index)], { maxBuffer: 16 * 1024 * 1024, timeout: Math.min(30000, seconds * 1000), killSignal: "SIGKILL" })).stdout;
      } catch (e) {
        if (e.code !== 1)
          throw e;
      }
      const paths = [...new Set([...output.split(`
`).filter((p) => p && delta.visible(p)), ...delta.additions.filter((p) => kind(p) !== "unknown")])];
      if (paths.length > 1e5)
        throw new Error("More than 100000 media paths; create a smaller folder index");
      if (stamp(index) !== currentStamp)
        throw new Error("Index changed during media discovery; retry");
      if (deltaFor(index).revision !== delta.revision)
        throw new Error("Incremental paths changed during media discovery; retry");
      db.exec("CREATE TEMP TABLE seen (path TEXT PRIMARY KEY)");
      const seen = db.query("INSERT INTO seen VALUES (?)");
      const add = db.query("INSERT OR IGNORE INTO files(path,kind) VALUES (?,?)");
      db.transaction(() => {
        for (const p of paths) {
          seen.run(p);
          add.run(p, kind(p));
        }
        db.exec("DELETE FROM files WHERE path NOT IN (SELECT path FROM seen)");
        db.query("INSERT OR REPLACE INTO meta VALUES ('indexStamp',?)").run(currentStamp);
        db.query("INSERT OR REPLACE INTO meta VALUES ('deltaRevision',?)").run(String(delta.revision));
      })();
      db.exec("DROP TABLE seen");
    }
    let probed = 0, reused = 0, failed = 0, pending = 0, changed = 0;
    const rows = db.query("SELECT path,size,mtime,status FROM files WHERE (?='media' OR kind=?) ORDER BY path").all(mediaKind, mediaKind);
    const updates = [];
    const update = db.query("UPDATE files SET size=?,mtime=?,status=?,duration=?,codec=?,sampleRate=?,channels=?,bitrate=?,width=?,height=?,source=?,error=? WHERE path=?");
    const flush = () => {
      if (!updates.length)
        return;
      db.transaction(() => {
        for (const values of updates)
          update.run(...values);
      })();
      updates.length = 0;
    };
    const queue = (values) => {
      updates.push(values);
      if (updates.length >= 64)
        flush();
    };
    for (const row of rows) {
      if (performance.now() >= deadline) {
        pending++;
        continue;
      }
      let s;
      try {
        s = fs6.statSync(row.path);
        if (!s.isFile())
          throw new Error("Not a file");
      } catch {
        if (row.status === "missing")
          reused++;
        else
          queue([null, null, "missing", null, null, null, null, null, null, null, null, "File missing", row.path]);
        continue;
      }
      if (s.size === row.size && s.mtimeMs === row.mtime && row.status !== "pending") {
        reused++;
        continue;
      }
      if (probed >= maxFiles || deadline - performance.now() < 100) {
        pending++;
        continue;
      }
      probed++;
      changed++;
      try {
        const values = await probe(row.path, native, deadline - performance.now());
        const after = fs6.statSync(row.path);
        if (s.size !== after.size || s.mtimeMs !== after.mtimeMs)
          throw new Error("File changed during extraction");
        queue([s.size, s.mtimeMs, "ok", ...values, null, row.path]);
      } catch (e) {
        if (e.code === "ENOENT")
          throw new Error("ffprobe is required for unsupported formats; install it and repeat enrichment");
        failed++;
        queue([s.size, s.mtimeMs, "failed", null, null, null, null, null, null, null, null, String(e.message).slice(0, 300), row.path]);
      }
    }
    flush();
    const counts = db.query("SELECT status,count(*) AS count FROM files WHERE (?='media' OR kind=?) GROUP BY status").all(mediaKind, mediaKind);
    return {
      index,
      kind: mediaKind,
      total: rows.length,
      probed,
      native: native.used,
      fallback: probed - native.used,
      reused,
      failed,
      changed,
      pending,
      counts,
      complete: pending === 0 && counts.every((r) => r.status === "ok"),
      database: mediaPath(index),
      snapshot: currentStamp
    };
  } finally {
    native.close();
    db?.close();
    release();
  }
}
function searchMedia(query, index, pq, limit, offset = 0) {
  const delta = deltaFor(index);
  if (pq.mediaFilters.some((f) => !Object.values(MEDIA_FIELDS).includes(f.field) || !["<", ">", "<=", ">=", "="].includes(f.op) || !Number.isFinite(f.value)))
    throw new Error("Invalid media predicate");
  const remedy = `Run fe enrich --index ${index} --kind media (or --kind audio for sounds); repeat until pending is 0.`;
  if (!fs6.existsSync(mediaPath(index)))
    return { paths: [], media: [], complete: false, warnings: ["Media metadata has not been indexed. " + remedy], coverage: { known: 0, unknown: null } };
  const db = openStore(index, true);
  db.exec("BEGIN");
  try {
    const snapshotCurrent = db.query("SELECT value FROM meta WHERE key='indexStamp'").get()?.value === stamp(index);
    const constraints = pq.constraints.map((c) => ({ re: new RegExp(c.pattern, "i"), negate: c.negate }));
    const groups = pq.fuzzy.map((t) => t.replace(/^'/, "").split("|").map((s) => s.toLowerCase()));
    const favorites = pq.favorites ? new Set(pq.favorites) : null;
    const matchesPath = (p) => (!favorites || favorites.has(p)) && !omitted(p, pq.omit) && constraints.every((c) => c.re.test(p) !== c.negate) && groups.every((g) => g.some((s) => p.toLowerCase().includes(s)));
    const fields = [...new Set(pq.mediaFilters.map((f) => f.field))];
    const baseSql = "SELECT path,status," + fields.join(",") + " FROM files WHERE status<>'excluded'";
    const baseRows = db.query(baseSql).all().filter((r) => matchesPath(r.path) && delta.visible(r.path));
    const unknown = baseRows.filter((r) => r.status !== "ok" || fields.some((f) => r[f] === null)).length;
    const condition = pq.mediaFilters.map((f) => `${f.field} ${f.op} ?`).join(" AND ");
    const selectSql = `SELECT * FROM files WHERE status='ok' AND ${condition}`;
    let rows = db.query(selectSql).all(...pq.mediaFilters.map((f) => f.value)).filter((r) => matchesPath(r.path) && delta.visible(r.path));
    if (pq.sizeFilter)
      rows = rows.filter((r) => matchesSize(r.size, pq.sizeFilter));
    if (pq.dmFilter)
      rows = rows.filter((r) => Date.now() - r.mtime < pq.dmFilter.days * 86400000);
    const sort = pq.sort;
    if (sort)
      rows.sort((a, b) => compareSearchProperties(a, b, sort));
    else {
      const order = new Map(rerank(rows.map((r) => r.path), query).map((p, i) => [p, i]));
      rows.sort((a, b) => order.get(a.path) - order.get(b.path));
    }
    let invalid = 0;
    const selected = [];
    let consumed = offset;
    for (const row of rows.slice(offset)) {
      consumed++;
      try {
        const s = fs6.statSync(row.path);
        if (s.size !== row.size || s.mtimeMs !== row.mtime) {
          invalid++;
          continue;
        }
      } catch {
        invalid++;
        continue;
      }
      selected.push(row);
      if (selected.length >= limit)
        break;
    }
    const warnings = [];
    if (unknown || !snapshotCurrent || invalid)
      warnings.push(`Media snapshot: ${unknown} unknown, ${invalid} changed/missing matches${snapshotCurrent ? "" : ", path index changed"}. ${remedy}`);
    return {
      paths: selected.map((r) => r.path),
      media: selected.map(({ error: _error, status: _status, ...r }) => r),
      complete: unknown === 0 && snapshotCurrent && invalid === 0,
      warnings,
      coverage: { known: baseRows.length - unknown, unknown, snapshotCurrent, matched: rows.length, limited: rows.length > selected.length },
      offset,
      nextOffset: consumed < rows.length ? consumed : null,
      snapshotId: `${stamp(index)}:${fs6.statSync(mediaPath(index)).mtimeMs}`,
      snapshot: true
    };
  } finally {
    db.exec("ROLLBACK");
    db.close();
  }
}

// ../findeverything-service-20261020/src/socket.ts
import * as fs7 from "fs";
import * as path7 from "path";
import * as http from "http";
var DEFAULT_SOCKET = path7.join(INDEX_DIR, "run", "search.sock");
async function listenSocket(server, socketPath, token, version, ownerPid) {
  socketPath = path7.resolve(socketPath);
  if (Buffer.byteLength(socketPath) > 100)
    throw new Error("Unix socket path must be at most 100 bytes");
  const dir = path7.dirname(socketPath);
  fs7.mkdirSync(dir, { recursive: true, mode: 448 });
  const owner = fs7.lstatSync(dir);
  if (!owner.isDirectory() || owner.uid !== process.getuid?.() || owner.mode & 63)
    throw new Error("Socket directory must be owned by you with mode 700");
  const release = acquireLock(socketPath + ".lock");
  const info = socketPath + ".json";
  let listening = false;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned)
      return;
    cleaned = true;
    if (listening) {
      fs7.rmSync(socketPath, { force: true });
      fs7.rmSync(info, { force: true });
    }
    release();
  };
  try {
    if (fs7.existsSync(socketPath)) {
      const old = fs7.lstatSync(socketPath);
      if (!old.isSocket() || old.uid !== process.getuid?.())
        throw new Error("Refusing to replace a non-owned socket or regular file");
      fs7.unlinkSync(socketPath);
    }
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    listening = true;
    fs7.chmodSync(socketPath, 384);
    fs7.writeFileSync(info, JSON.stringify({ token, version, apiRevision: 6, pid: process.pid, ownerPid: ownerPid ?? null }), { mode: 384 });
    fs7.chmodSync(info, 384);
    process.once("exit", cleanup);
    server.once("close", cleanup);
    console.error(JSON.stringify({ socket: socketPath, version }));
  } catch (e) {
    cleanup();
    server.close();
    throw e;
  }
}
function socketRequest(socketPath, route) {
  const metadata = fs7.lstatSync(socketPath + ".json");
  if (metadata.uid !== process.getuid?.() || metadata.mode & 63 || metadata.isSymbolicLink())
    throw new Error("Unsafe socket credentials permissions");
  const { token } = JSON.parse(fs7.readFileSync(socketPath + ".json", "utf8"));
  return new Promise((resolve, reject) => {
    const req = http.get({ socketPath, path: route, headers: { Host: "localhost", Authorization: `Bearer ${token}` }, timeout: 1e4 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
        if (body.length > 4 * 1024 * 1024)
          req.destroy(new Error("Socket response exceeds 4 MiB"));
      });
      res.on("error", reject);
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (res.statusCode !== 200)
            throw new Error(data.error || `HTTP ${res.statusCode}`);
          resolve(data);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Socket request timed out")));
    req.on("error", reject);
  });
}

// ../findeverything-service-20261020/src/browse.ts
import * as fs8 from "fs";
import { createInterface } from "readline";
var checkpoints = new Map;
async function browse(index, limit, offset) {
  const file = indexPathFor(index), before = fs8.statSync(file);
  const delta = deltaFor(index);
  const stamp = `${before.mtimeMs}:${before.size}:${delta.revision}`;
  let cached = checkpoints.get(index);
  if (cached?.stamp !== stamp) {
    if (checkpoints.size >= 8)
      checkpoints.delete(checkpoints.keys().next().value);
    checkpoints.set(index, cached = { stamp, points: new Map([[0, 0]]) });
  }
  let position = 0, bytes = 0;
  for (const [row, byte] of cached.points)
    if (row <= offset && row >= position) {
      position = row;
      bytes = byte;
    }
  const source = fs8.createReadStream(file, { start: bytes, highWaterMark: 64 * 1024 });
  const lines = createInterface({ input: source, crlfDelay: Infinity });
  const paths = [];
  const deadline = performance.now() + 8000;
  let more = false;
  let endOfBase = true;
  try {
    for await (const line of lines) {
      if (position % 1024 === 0 && performance.now() > deadline)
        throw new Error("Browse timed out; use the socket service for nearby page checkpoints");
      if (!line)
        continue;
      const length = Buffer.byteLength(line) + 1;
      if (!delta.visible(line, true)) {
        bytes += length;
        continue;
      }
      if (position < offset) {
        position++;
        bytes += length;
        continue;
      }
      if (paths.length === limit) {
        more = true;
        endOfBase = false;
        break;
      }
      paths.push(line);
      position++;
      bytes += Buffer.byteLength(line) + 1;
    }
  } finally {
    lines.close();
    source.destroy();
  }
  cached.points.set(position, bytes);
  if (endOfBase)
    for (const p of delta.additions) {
      if (position++ < offset)
        continue;
      if (paths.length === limit) {
        more = true;
        break;
      }
      paths.push(p);
    }
  const after = fs8.statSync(file);
  if (before.mtimeMs !== after.mtimeMs || before.size !== after.size)
    throw new Error("Path snapshot changed; restart pagination");
  if (cached.points.size >= 1024)
    cached.points.delete(cached.points.keys().next().value);
  if (deltaFor(index).revision !== delta.revision)
    throw new Error("Path updates changed; restart pagination");
  return {
    paths,
    nextOffset: more ? offset + paths.length : null,
    offset,
    snapshotId: stamp,
    snapshot: true,
    complete: true,
    warnings: ["Indexed paths plus incremental changes; configured exclusions and macOS permissions apply."]
  };
}

// ../findeverything-service-20261020/src/semantic.ts
import { Database as Database3 } from "bun:sqlite";
import * as fs10 from "fs";
import * as path9 from "path";

// ../findeverything-service-20261020/src/semantic-worker.ts
import * as fs9 from "fs";
import * as os4 from "os";
import * as path8 from "path";
import { spawn as spawn3 } from "child_process";
import { createInterface as createInterface2 } from "readline";
var __dirname = import.meta.dir;
var MODEL_ID = "clap-htsat-q8:c28f2883575e590e04d3146ff0713c2448d691ba:10s-v1";
function runtimeDir() {
  if (process.env.FE_SEMANTIC_RUNTIME)
    return path8.resolve(process.env.FE_SEMANTIC_RUNTIME);
  const installed = path8.join(os4.homedir(), "Library/Application Support/FindEverything/semantic-runtime");
  if (fs9.existsSync(path8.join(installed, "worker.mjs")))
    return installed;
  return path8.resolve(__dirname, "../runtime");
}
function semanticStatus() {
  const root = runtimeDir();
  let manifest;
  try {
    manifest = JSON.parse(fs9.readFileSync(path8.join(root, "ready.json"), "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT")
      throw e;
  }
  const ready = manifest?.revision === MODEL_ID.split(":")[1] && fs9.existsSync(path8.join(root, "node_modules/@huggingface/transformers/package.json")) && ["config.json", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "onnx/audio_model_quantized.onnx", "onnx/text_model_quantized.onnx"].every((name) => {
    try {
      return fs9.statSync(path8.join(root, "model", name)).size === manifest.files?.[name]?.bytes;
    } catch (e) {
      if (e.code === "ENOENT")
        return false;
      throw e;
    }
  });
  return { ready: !!ready, model: MODEL_ID, runtime: root, manifest };
}

class SemanticWorker {
  detached = process.platform !== "win32" && process.env.FE_SEARCH_WORKER !== "1";
  child;
  sequence = 0;
  pending;
  idle;
  tail = Promise.resolve();
  queued = 0;
  embed(kind, value, timeout = 20000) {
    if (this.queued >= 2)
      return Promise.reject(new Error("Sound model queue is full; retry after the current request"));
    this.queued++;
    const result = this.tail.then(() => this.perform(kind, value, timeout));
    this.tail = result.catch(() => {}).finally(() => {
      this.queued--;
    });
    return result;
  }
  async perform(kind, value, timeout) {
    if (!this.child || this.child.exitCode !== null)
      this.start();
    clearTimeout(this.idle);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close();
        reject(new Error("Local sound model timed out"));
      }, timeout);
      this.pending = { id, resolve: (v) => {
        clearTimeout(timer);
        this.pending = undefined;
        this.idle = setTimeout(() => this.close(), 60000);
        this.idle.unref();
        resolve(v);
      }, reject: (e) => {
        clearTimeout(timer);
        this.pending = undefined;
        reject(e);
      } };
      this.child.stdin.write(JSON.stringify({ id, kind, ...kind === "text" ? { text: value } : { path: value } }) + `
`);
    });
  }
  start() {
    if (!semanticStatus().ready)
      throw new Error("Local sound model is not ready. Run fe semantic setup");
    const child = track(spawn3(findBin("node"), [path8.join(runtimeDir(), "worker.mjs")], { detached: this.detached, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OMP_NUM_THREADS: "2", TOKENIZERS_PARALLELISM: "false", FE_FFMPEG: findBin("ffmpeg") } }));
    this.child = child;
    const lines = createInterface2({ input: child.stdout });
    let length = 0;
    child.stdout.on("data", (d) => {
      length += d.length;
      if (length > 65536) {
        this.close();
      }
    });
    lines.on("line", (line) => {
      length = 0;
      try {
        const r = JSON.parse(line), pending = this.pending;
        if (!pending || pending.id !== r.id)
          return;
        if (r.error)
          return pending.reject(Object.assign(new Error(r.error), { code: r.code === "AUDIO_DECODE" ? "AUDIO_DECODE" : "MODEL_RUNTIME" }));
        if (!Array.isArray(r.vector) || r.vector.length !== 512 || r.vector.some((v) => !Number.isFinite(v)))
          throw new Error("Invalid local sound vector");
        pending.resolve(r.vector);
      } catch (e) {
        this.pending?.reject(e);
        this.close();
      }
    });
    let errors = "";
    child.stderr.on("data", (d) => {
      errors = (errors + d.toString()).slice(-2000);
    });
    child.stdin.on("error", (e) => this.pending?.reject(e));
    child.on("error", (e) => this.pending?.reject(e));
    child.once("close", () => {
      lines.close();
      if (this.child === child) {
        this.child = undefined;
        this.pending?.reject(new Error(`Local sound worker stopped: ${errors.slice(-400)}`));
      }
    });
  }
  close() {
    clearTimeout(this.idle);
    const c = this.child;
    this.child = undefined;
    this.pending?.reject(new Error("Local sound worker stopped"));
    if (!c)
      return;
    try {
      if (this.detached && c.pid)
        process.kill(-c.pid, "SIGKILL");
      else
        c.kill("SIGKILL");
    } catch (e) {
      if (e.code !== "ESRCH")
        throw e;
    }
  }
}

// ../findeverything-service-20261020/src/semantic.ts
var semanticPath = (index) => path9.join(INDEX_DIR, `sound-${validateName(index)}.sqlite`);
var worker = new SemanticWorker;
var closeSoundWorker = () => worker.close();
var textCache = new Map;
function store(index, readonly = false) {
  const db = new Database3(semanticPath(index), { readonly, create: !readonly });
  db.exec("PRAGMA busy_timeout=1000; PRAGMA cache_size=-4096; PRAGMA temp_store=MEMORY;");
  if (!readonly)
    db.exec("CREATE TABLE IF NOT EXISTS vectors(path TEXT PRIMARY KEY, size INTEGER, mtime REAL, model TEXT NOT NULL, vector BLOB, error TEXT); CREATE TABLE IF NOT EXISTS aliases(path TEXT PRIMARY KEY,canonical TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT)");
  return db;
}
function candidates(index, pq, onlyPaths) {
  if (!fs10.existsSync(mediaPath(index)))
    throw new Error(`Audio metadata is missing. Run fe enrich --index ${index}`);
  const db = new Database3(mediaPath(index), { readonly: true });
  const mediaStamp = fs10.statSync(mediaPath(index)).mtimeMs;
  db.exec("BEGIN");
  try {
    const s = fs10.statSync(indexPathFor(index)), stamp = `${s.mtimeMs}:${s.size}`;
    const known = new Set(["duration", "sampleRate", "channels", "bitrate", "width", "height"]);
    if (pq.mediaFilters.some((f) => !known.has(f.field) || !["<", ">", "<=", ">=", "="].includes(f.op) || !Number.isFinite(f.value)))
      throw new Error("Invalid sound predicate");
    const delta = deltaFor(index);
    let rows = onlyPaths ? db.query("SELECT * FROM files WHERE kind='audio' AND status<>'excluded' AND path IN (SELECT value FROM json_each(?)) ORDER BY path").all(JSON.stringify(onlyPaths)) : db.query("SELECT * FROM files WHERE kind='audio' AND status<>'excluded' ORDER BY path").all();
    const favorites = pq.favorites ? new Set(pq.favorites) : null;
    rows = rows.filter((r) => delta.visible(r.path) && (!favorites || favorites.has(r.path)) && !omitted(r.path, pq.omit));
    const constraints = pq.constraints.map((c) => ({ re: new RegExp(c.pattern, "i"), negate: c.negate }));
    rows = rows.filter((r) => constraints.every((c) => c.re.test(r.path) !== c.negate) && pq.fuzzy.every((t) => t.replace(/^'/, "").split("|").some((w) => r.path.toLowerCase().includes(w.toLowerCase()))));
    if (pq.sizeFilter)
      rows = rows.filter((r) => matchesSize(r.size, pq.sizeFilter));
    if (pq.dmFilter)
      rows = rows.filter((r) => Date.now() - r.mtime < pq.dmFilter.days * 86400000);
    if (rows.length > 1e5)
      throw new Error("Sound scope exceeds 100000 candidates; select a smaller folder or duration range");
    const metadataUnknown = rows.filter((r) => pq.mediaFilters.some((f) => r[f.field] == null)).length;
    rows = rows.filter((r) => pq.mediaFilters.every((f) => r[f.field] != null && (f.op === "<" ? r[f.field] < f.value : f.op === ">" ? r[f.field] > f.value : f.op === "<=" ? r[f.field] <= f.value : f.op === ">=" ? r[f.field] >= f.value : r[f.field] === f.value)));
    if (fs10.statSync(mediaPath(index)).mtimeMs !== mediaStamp)
      throw new Error("Audio metadata changed during search; retry");
    return { rows, stamp, mediaStamp, metadataUnknown, current: db.query("SELECT value FROM meta WHERE key='indexStamp'").get()?.value === stamp };
  } finally {
    db.exec("ROLLBACK");
    db.close();
  }
}
async function indexSounds(index, query, maxFiles, seconds, onlyPaths) {
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 1e4 || seconds < 1 || seconds > 300)
    throw new Error("Invalid sound indexing budget");
  const deadline = performance.now() + seconds * 1000;
  if (!semanticStatus().ready)
    throw new Error("Run fe semantic setup first");
  const pq = parseQuery(query), { rows: paths, stamp } = candidates(index, pq, onlyPaths);
  const aliases = [], unique = new Map;
  for (const row of paths) {
    try {
      const canonical = fs10.realpathSync(row.path);
      aliases.push([row.path, canonical]);
      if (!unique.has(canonical))
        unique.set(canonical, { ...row, path: canonical });
    } catch (e) {
      if (e.code !== "ENOENT")
        throw e;
    }
  }
  const rows = [...unique.values()];
  const hints = (pq.semantic || "").split(/\s+/).filter((w) => w.length > 3 && !["sound", "effect", "effects"].includes(w));
  const priority = (r) => hints.filter((h) => path9.basename(r.path).toLowerCase().includes(h)).length;
  rows.sort((a, b) => priority(b) - priority(a));
  fs10.mkdirSync(INDEX_DIR, { recursive: true, mode: 448 });
  const release = acquireLock(semanticPath(index) + ".lock");
  let db;
  let analyzed = 0, reused = 0, failed = 0, pending = paths.length - aliases.length;
  const updates = [];
  const flush = () => {
    if (!updates.length)
      return;
    db.transaction(() => {
      const put = db.query("INSERT OR REPLACE INTO vectors VALUES(?,?,?,?,?,?)");
      for (const u of updates)
        put.run(...u);
    })();
    updates.length = 0;
  };
  try {
    db = store(index);
    if (!onlyPaths)
      db.query("INSERT INTO settings VALUES ('query',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value").run(query);
    const alias = db.query("INSERT INTO aliases VALUES(?,?) ON CONFLICT(path) DO UPDATE SET canonical=excluded.canonical WHERE canonical<>excluded.canonical");
    const migrate = db.query("INSERT OR IGNORE INTO vectors SELECT ?,size,mtime,model,vector,error FROM vectors WHERE path=?");
    const remove = db.query("DELETE FROM vectors WHERE path=?");
    db.transaction(() => {
      for (const [p, canonical] of aliases) {
        alias.run(p, canonical);
        if (p !== canonical) {
          migrate.run(canonical, p);
          remove.run(p);
        }
      }
    })();
    for (const row of rows) {
      if (performance.now() >= deadline) {
        pending++;
        continue;
      }
      let stat;
      try {
        stat = fs10.statSync(row.path);
        if (!stat.isFile()) {
          pending++;
          continue;
        }
      } catch {
        pending++;
        continue;
      }
      const old = db.query("SELECT size,mtime,model FROM vectors WHERE path=?").get(row.path);
      if (old?.model === MODEL_ID && old.size === stat.size && old.mtime === stat.mtimeMs) {
        reused++;
        continue;
      }
      if (analyzed >= maxFiles || deadline - performance.now() < 1000) {
        pending++;
        continue;
      }
      analyzed++;
      try {
        const vector = await worker.embed("audio", row.path, Math.min(20000, deadline - performance.now()));
        const after = fs10.statSync(row.path);
        if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) {
          pending++;
          continue;
        }
        updates.push([row.path, stat.size, stat.mtimeMs, MODEL_ID, Buffer.from(new Float32Array(vector).buffer), null]);
      } catch (e) {
        if (e.code !== "AUDIO_DECODE") {
          flush();
          throw e;
        }
        failed++;
        updates.push([row.path, stat.size, stat.mtimeMs, MODEL_ID, null, String(e.message).slice(0, 400)]);
      }
      if (updates.length >= 16)
        flush();
    }
    flush();
    return { index, model: MODEL_ID, analyzed, reused, failed, pending, candidates: rows.length, candidatePaths: paths.length, aliases: aliases.length - rows.length, missingPaths: paths.length - aliases.length, snapshot: stamp, database: semanticPath(index), sampleSeconds: 10 };
  } finally {
    if (!onlyPaths)
      worker.close();
    db?.close();
    release();
  }
}
async function refreshSounds(index, paths) {
  if (!fs10.existsSync(semanticPath(index)) || !semanticStatus().ready)
    return;
  const db = store(index, true);
  let query;
  try {
    if (db.query("SELECT 1 FROM sqlite_master WHERE name='settings'").get())
      query = db.query("SELECT value FROM settings WHERE key='query'").get()?.value;
  } finally {
    db.close();
  }
  if (query !== undefined)
    return indexSounds(index, query, 8, 8, paths);
}
async function searchSounds(index, pq, limit, offset) {
  const empty = { paths: [], complete: false, nextOffset: null, semantic: true };
  if (!fs10.existsSync(mediaPath(index)))
    return { ...empty, warnings: [`Media metadata has not been indexed. Run fe enrich --index ${index}`], coverage: { known: 0, unknown: null } };
  if (!fs10.existsSync(semanticPath(index)))
    return { ...empty, warnings: [`Sound embeddings have not been indexed. Run fe semantic setup, then fe semantic index --index ${index} --query '(kurze Lasersounds)'`], coverage: { known: 0, unknown: null } };
  const { rows, stamp, mediaStamp, current, metadataUnknown } = candidates(index, pq);
  const soundStamp = fs10.statSync(semanticPath(index)).mtimeMs;
  const db = store(index, true);
  let saved, aliases, failures;
  try {
    saved = db.query("SELECT path,size,mtime,vector FROM vectors WHERE model=? AND vector IS NOT NULL").all(MODEL_ID);
    failures = db.query("SELECT path,size,mtime FROM vectors WHERE model=? AND vector IS NULL").all(MODEL_ID);
    aliases = db.query("PRAGMA table_info(aliases)").all().length ? db.query("SELECT path,canonical FROM aliases").all() : [];
  } finally {
    db.close();
  }
  if (fs10.statSync(semanticPath(index)).mtimeMs !== soundStamp)
    throw new Error("Sound index changed during search; retry");
  const byPath = new Map(saved.map((r) => [r.path, r]));
  const byAlias = new Map(aliases.map((r) => [r.path, r.canonical]));
  const unique = new Map;
  for (const row of rows) {
    const canonical = byAlias.get(row.path) || row.path, old = unique.get(canonical);
    if (!old || row.path === canonical || old.path !== canonical && row.path.length < old.path.length)
      unique.set(canonical, { ...row, canonical });
  }
  const eligible = [...unique.values()].filter((r) => {
    const v = byPath.get(r.canonical);
    return v && v.size === r.size && v.mtime === r.mtime;
  });
  const byFailure = new Map(failures.map((r) => [r.path, r]));
  const failed = [...unique.values()].filter((r) => {
    const f = byFailure.get(r.canonical);
    return f && f.size === r.size && f.mtime === r.mtime;
  }).length;
  if (!eligible.length)
    return { ...empty, warnings: [`No cached sound vectors match these filters. Run fe semantic index --index ${index} --query '${pq.semantic}' with the intended filters.`], coverage: { known: 0, unknown: rows.length } };
  const plan = soundPlan(pq.semantic);
  const textVector = async (text) => {
    let vector = textCache.get(text);
    if (vector)
      return vector;
    vector = await worker.embed("text", text);
    if (textCache.size >= 128)
      textCache.delete(textCache.keys().next().value);
    textCache.set(text, vector);
    return vector;
  };
  const descriptionVector = await textVector(plan.description);
  const anchorVector = plan.anchorWeight ? await textVector(plan.anchor) : descriptionVector;
  const vector = descriptionVector.map((v, i) => v * (1 - plan.anchorWeight) + anchorVector[i] * plan.anchorWeight);
  const ranked = eligible.map((row) => {
    const b = byPath.get(row.canonical).vector;
    const v = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    if (v.length !== 512)
      throw new Error("Invalid cached sound vector; rebuild this sound index");
    let score = 0;
    for (let i = 0;i < 512; i++)
      score += v[i] * vector[i];
    return { ...row, score };
  }).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  if (pq.sort)
    ranked.sort((a, b) => compareSearchProperties(a, b, pq.sort));
  const selected = [];
  let consumed = offset, changed = 0;
  for (const row of ranked.slice(offset)) {
    consumed++;
    try {
      const s = fs10.statSync(row.path);
      if (s.size !== row.size || s.mtimeMs !== row.mtime) {
        changed++;
        continue;
      }
    } catch {
      changed++;
      continue;
    }
    selected.push(row);
    if (selected.length === limit)
      break;
  }
  const unknown = unique.size - eligible.length;
  return {
    paths: selected.map((r) => r.path),
    scores: selected.map((r) => ({ path: r.path, similarity: r.score })),
    semantic: true,
    semanticPlan: plan,
    model: MODEL_ID,
    complete: false,
    snapshot: true,
    snapshotId: `${stamp}:${mediaStamp}:${soundStamp}`,
    nextOffset: consumed < ranked.length ? consumed : null,
    offset,
    coverage: { known: eligible.length, unknown, failed, metadataUnknown, matched: ranked.length, changed, aliases: rows.length - unique.size, snapshotCurrent: current },
    warnings: [`Approximate acoustic ranking of ${eligible.length} unique cached sounds; ${unknown > failed ? `${unknown - failed} unanalyzed, ` : ""}${failed} cached decode failures, ${metadataUnknown} paths with unknown metadata, ${changed} changed/missing matches. First 10 seconds per file. Semantic recall is not exhaustive.${plan.anchorWeight ? ` Anchor: ${plan.anchor} (80%).` : ""}${current ? "" : " Path snapshot changed; enrich metadata explicitly."}`]
  };
}

// ../findeverything-service-20261020/src/live.ts
import * as fs12 from "fs";
import * as path11 from "path";

// ../findeverything-service-20261020/src/path-search.ts
import { Database as Database4 } from "bun:sqlite";
import * as fs11 from "fs";
import path10 from "path";
import { createInterface as createInterface3 } from "readline";
var searchIndexPath = (index) => path10.join(INDEX_DIR, `search-${validateName(index)}.sqlite`);
var VERSION = "2";
var FULL = "d.path || f.name || CASE WHEN f.slash=1 THEN '/' ELSE '' END";
var connections = new Map;
var propertyConnection;
var getMeta = (db, key) => db.query("SELECT value FROM meta WHERE key=?").get(key)?.value;
var directChanges = (db) => db.query("SELECT changes() AS n").get().n;
var setMeta = (db, key, value) => db.query("INSERT OR REPLACE INTO meta VALUES (?,?)").run(key, String(value));
function tune(db) {
  db.exec("PRAGMA busy_timeout=1000; PRAGMA cache_size=-8192; PRAGMA temp_store=MEMORY; PRAGMA threads=1;");
}
function closeCached(index) {
  const c = connections.get(index);
  if (c) {
    c.db.close();
    connections.delete(index);
  }
}
function closeProperties(index) {
  if (propertyConnection?.index === index) {
    propertyConnection.db.close();
    propertyConnection = undefined;
  }
}
function openProperties(index) {
  const file = searchIndexPath(index);
  if (!fs11.existsSync(file))
    return;
  const stat = fs11.statSync(file), source = baseStamp(index), stamp = `${stat.mtimeMs}:${stat.size}:${source}`;
  if (propertyConnection?.index === index && propertyConnection.stamp === stamp)
    return propertyConnection.db;
  if (propertyConnection)
    closeProperties(propertyConnection.index);
  const db = new Database4(file, { readonly: true });
  try {
    tune(db);
    db.exec("PRAGMA cache_size=-1024");
    if (getMeta(db, "version") !== VERSION || getMeta(db, "source") !== source || getMeta(db, "ready") !== "1") {
      db.close();
      return;
    }
    propertyConnection = { index, stamp, db };
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}
var damagedCache = (e) => ["SQLITE_CORRUPT", "SQLITE_NOTADB"].includes(e.code) || /not a database|database disk image is malformed|no such table: (meta|files|directories)/i.test(String(e.message));
function splitPath(p) {
  const clean = p.replace(/\/$/, "") || "/";
  return { parent: path10.dirname(clean).replace(/\/$/, "") + "/", name: path10.basename(clean), slash: p.endsWith("/") && p !== "/" ? 1 : 0 };
}
function openReady(index) {
  const file = searchIndexPath(index);
  if (!fs11.existsSync(file))
    return;
  const s = fs11.statSync(file), stamp = `${s.mtimeMs}:${s.size}:${baseStamp(index)}`;
  const previous = connections.get(index);
  if (previous?.stamp === stamp) {
    connections.delete(index);
    connections.set(index, previous);
    return previous.db;
  }
  closeCached(index);
  const db = new Database4(file, { readonly: true });
  try {
    tune(db);
    if (getMeta(db, "version") !== VERSION || getMeta(db, "source") !== baseStamp(index) || getMeta(db, "ready") !== "1") {
      db.close();
      return;
    }
    while (connections.size >= 3)
      closeCached(connections.keys().next().value);
    const stored = getMeta(db, "indexedRows"), valid = getMeta(db, "rowCountVersion") === "1" && /^\d+$/.test(stored ?? "") && Number.isSafeInteger(Number(stored));
    const context = { db, stamp, revision: "", directoryCounts: new Map, counts: new Map, sets: new Map, seeds: new Map, sequence: 0, directories: -1, rows: valid ? Number(stored) : db.query("SELECT count(*) AS n FROM files").get().n };
    connections.set(index, context);
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}
function schema(db, source) {
  tune(db);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE directories(id INTEGER PRIMARY KEY,path TEXT UNIQUE,pathKey TEXT NOT NULL);
    CREATE TABLE files(id INTEGER PRIMARY KEY,parent INTEGER NOT NULL,name TEXT NOT NULL,nameKey TEXT NOT NULL,slash INTEGER DEFAULT 0,size INTEGER,mtime REAL,dir INTEGER,UNIQUE(parent,name));
    CREATE INDEX file_names ON files(nameKey,id);
    CREATE INDEX file_size ON files(size,id);
    CREATE INDEX file_modified ON files(mtime,id);
    CREATE VIRTUAL TABLE names_fts USING fts5(nameKey,content=files,content_rowid=id,tokenize=trigram,columnsize=0);
    CREATE VIRTUAL TABLE directories_fts USING fts5(pathKey,content=directories,content_rowid=id,tokenize=trigram,columnsize=0);
    CREATE TRIGGER directory_added AFTER INSERT ON directories BEGIN INSERT INTO directories_fts(rowid,pathKey) VALUES(new.id,new.pathKey); END;
    CREATE TRIGGER file_added AFTER INSERT ON files BEGIN INSERT INTO names_fts(rowid,nameKey) VALUES(new.id,new.nameKey); END;
    CREATE TRIGGER file_removed AFTER DELETE ON files BEGIN INSERT INTO names_fts(names_fts,rowid,nameKey) VALUES('delete',old.id,old.nameKey); END;`);
  db.transaction(() => {
    for (const [key, value] of Object.entries({ version: VERSION, source, offset: "0", rows: "0", ready: "0", liveRevision: "0", propertiesRevision: "0" }))
      setMeta(db, key, value);
  })();
}
function inserter(db) {
  const parents = new Map, addParent = db.query("INSERT OR IGNORE INTO directories(path,pathKey) VALUES (?,?)"), findParent = db.query("SELECT id FROM directories WHERE path=?");
  const add = db.query("INSERT OR IGNORE INTO files(parent,name,nameKey,slash) VALUES (?,?,?,?)");
  return (p) => {
    const s = splitPath(p);
    let id = parents.get(s.parent);
    if (id === undefined) {
      addParent.run(s.parent, s.parent.toLowerCase());
      id = findParent.get(s.parent).id;
      if (parents.size >= 8192)
        parents.delete(parents.keys().next().value);
      parents.set(s.parent, id);
    }
    add.run(id, s.name, s.name.toLowerCase(), s.slash);
    return directChanges(db);
  };
}
function orderedIndexes(db) {
  db.exec("CREATE INDEX IF NOT EXISTS directory_names ON directories(pathKey,id); CREATE INDEX IF NOT EXISTS parent_names ON files(parent,nameKey,id);");
  setMeta(db, "ordered", 1);
  if (getMeta(db, "rowCountVersion") !== "1") {
    setMeta(db, "indexedRows", db.query("SELECT count(*) AS n FROM files").get().n);
    setMeta(db, "rowCountVersion", 1);
  }
}
function reuseMediaProperties(index, db) {
  const file = path10.join(INDEX_DIR, `media-${validateName(index)}.sqlite`);
  if (!fs11.existsSync(file))
    return;
  const media = new Database4(file, { readonly: true });
  try {
    if (getMeta(media, "indexStamp") !== baseStamp(index))
      return;
    const update = db.query("UPDATE files SET size=?,mtime=?,dir=? WHERE parent=(SELECT id FROM directories WHERE path=?) AND name=? AND size IS NULL AND mtime IS NULL");
    let reused = 0;
    db.transaction(() => {
      for (const r of media.query("SELECT path,size,mtime,status FROM files WHERE size IS NOT NULL AND mtime IS NOT NULL LIMIT 100000").iterate()) {
        const s = splitPath(r.path);
        reused += update.run(r.size, r.mtime, r.status === "ok" ? 0 : null, s.parent, s.name).changes;
      }
      if (reused)
        setMeta(db, "propertiesRevision", Number(getMeta(db, "propertiesRevision")) + 1);
    })();
  } finally {
    media.close();
  }
}
async function prepareSearch(index, seconds = 60, maxRows = 1e7) {
  const result = await prepareSnapshot(index, seconds, maxRows);
  if (result.ready) {
    syncSearch(index);
    return { ...result, ...searchIndexStatus(index) };
  }
  return result;
}
async function prepareSnapshot(index, seconds, maxRows) {
  const file = searchIndexPath(index), source = baseStamp(index);
  let ready;
  try {
    ready = openReady(index);
  } catch (e) {
    if (!damagedCache(e))
      throw e;
  }
  if (ready) {
    if (getMeta(ready, "ordered") !== "1" || getMeta(ready, "rowCountVersion") !== "1") {
      const release = acquireLock(file + ".lock");
      closeCached(index);
      const db = new Database4(file);
      tune(db);
      try {
        orderedIndexes(db);
      } finally {
        db.close();
        release();
      }
    }
    return { ...searchIndexStatus(index), reused: true };
  }
  const release = acquireLock(file + ".lock"), stage = file + ".building";
  let db;
  const started = performance.now(), deadline = started + seconds * 1000;
  try {
    if (fs11.existsSync(stage)) {
      try {
        db = new Database4(stage);
        if (getMeta(db, "source") !== source || getMeta(db, "version") !== VERSION) {
          db.close();
          db = undefined;
        }
      } catch (e) {
        db?.close();
        db = undefined;
        if (!damagedCache(e))
          throw e;
      }
      if (!db)
        for (const suffix of ["", "-wal", "-shm"])
          fs11.rmSync(stage + suffix, { force: true });
    }
    if (!db) {
      db = new Database4(stage, { create: true });
      schema(db, source);
    } else
      tune(db);
    let offset = Number(getMeta(db, "offset")), rows = Number(getMeta(db, "rows")), processed = 0;
    const stream = fs11.createReadStream(indexPathFor(index), { start: offset, highWaterMark: 256 * 1024 }), lines = createInterface3({ input: stream, crlfDelay: Infinity });
    const add = inserter(db), batch = [];
    const commit = () => {
      if (!batch.length)
        return;
      db.transaction(() => {
        for (const p of batch)
          add(p);
        setMeta(db, "offset", offset);
        setMeta(db, "rows", rows);
      })();
      batch.length = 0;
    };
    let finished = true;
    try {
      for await (const p of lines) {
        if (p.length > 1024 * 1024)
          throw new Error("Indexed path exceeds 1 MiB");
        offset += Buffer.byteLength(p) + 1;
        if (p) {
          batch.push(p);
          rows++;
          processed++;
        }
        if (batch.length >= 1024) {
          commit();
          if (fs11.statSync(stage).size > 6 * 1024 ** 3)
            throw new Error("Search accelerator exceeds 6 GiB; use a narrower profile");
          await new Promise((r) => setImmediate(r));
        }
        if (processed >= maxRows || performance.now() >= deadline) {
          finished = false;
          break;
        }
      }
      commit();
    } finally {
      lines.close();
      stream.destroy();
    }
    if (baseStamp(index) !== source)
      throw new Error("Path snapshot changed during preparation; retry to use the new snapshot");
    if (finished || offset >= fs11.statSync(indexPathFor(index)).size) {
      reuseMediaProperties(index, db);
      orderedIndexes(db);
      setMeta(db, "ready", 1);
      db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
      db.close();
      db = undefined;
      closeCached(index);
      fs11.renameSync(stage, file);
      return { ...searchIndexStatus(index), processed, elapsedMs: Math.round(performance.now() - started) };
    }
    return { ready: false, index, processed, rows, bytesRead: offset, totalBytes: fs11.statSync(indexPathFor(index)).size, elapsedMs: Math.round(performance.now() - started), resumable: true };
  } finally {
    db?.close();
    release();
  }
}
function searchIndexStatus(index) {
  const db = openReady(index);
  if (!db)
    return { index, ready: false };
  return {
    index,
    ready: true,
    rows: connections.get(index).rows,
    propertiesKnown: db.query("SELECT count(*) AS n FROM files WHERE size IS NOT NULL AND mtime IS NOT NULL").get().n,
    bytes: fs11.statSync(searchIndexPath(index)).size,
    liveRevision: Number(getMeta(db, "liveRevision")),
    propertiesRevision: Number(getMeta(db, "propertiesRevision"))
  };
}
function cachedFileProperties(index, p) {
  const db = openProperties(index);
  if (!db)
    return;
  const s = splitPath(p);
  return db.query("SELECT size,mtime,dir FROM files WHERE parent=(SELECT id FROM directories WHERE path=?) AND name=?").get(s.parent, s.name);
}
function syncSearch(index) {
  const current = openProperties(index);
  if (!current || !fs11.existsSync(livePath()))
    return;
  const source = baseStamp(index), after = Number(getMeta(current, "liveRevision"));
  const live = new Database4(livePath(), { readonly: true });
  let changes, revision;
  try {
    live.exec("BEGIN");
    const state = live.query("SELECT revision FROM scopes WHERE name=? AND stamp=?").get(index, source);
    if (!state || state.revision === after)
      return;
    revision = state.revision;
    changes = live.query("SELECT path,present,tree,revision FROM changes WHERE scope=? AND revision>? ORDER BY revision,path").all(index, after);
  } finally {
    live.close();
  }
  if (changes.length > 1e5)
    throw new Error("Search accelerator has over 100000 pending changes; prepare it again explicitly");
  const file = searchIndexPath(index), release = acquireLock(file + ".lock");
  let db;
  try {
    closeCached(index);
    closeProperties(index);
    db = new Database4(file);
    tune(db);
    if (getMeta(db, "source") !== source)
      return;
    const committed = Number(getMeta(db, "liveRevision"));
    if (committed >= revision)
      return;
    let rowCount = getMeta(db, "rowCountVersion") === "1" ? Number(getMeta(db, "indexedRows")) : db.query("SELECT count(*) AS n FROM files").get().n;
    const add = inserter(db), remove = db.query("DELETE FROM files WHERE parent=(SELECT id FROM directories WHERE path=?) AND name=?");
    const metadata = db.query("UPDATE files SET size=?,mtime=?,dir=?,slash=CASE WHEN ?=0 THEN 0 ELSE slash END WHERE parent=(SELECT id FROM directories WHERE path=?) AND name=?");
    db.transaction(() => {
      for (const c of changes) {
        if (c.revision <= committed)
          continue;
        const s = splitPath(c.path);
        if (c.tree) {
          const prefix = c.path.replace(/\/$/, "") + "/";
          db.query("DELETE FROM files WHERE parent IN (SELECT id FROM directories WHERE path=? OR substr(path,1,?)=?)").run(prefix, prefix.length, prefix);
          rowCount -= directChanges(db);
        }
        if (!c.present) {
          remove.run(s.parent, s.name);
          rowCount -= directChanges(db);
        } else {
          rowCount += add(c.path);
          try {
            const stat = fs11.statSync(c.path), directory = Number(stat.isDirectory());
            metadata.run(stat.size, stat.mtimeMs, directory, directory, s.parent, s.name);
          } catch (e) {
            if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(e.code))
              throw e;
          }
        }
      }
      setMeta(db, "liveRevision", revision);
      setMeta(db, "propertiesRevision", Number(getMeta(db, "propertiesRevision")) + 1);
      setMeta(db, "indexedRows", rowCount);
      setMeta(db, "rowCountVersion", 1);
    })();
  } finally {
    db?.close();
    release();
  }
}
async function indexProperties(index, maxFiles = 1e4, seconds = 60) {
  if (!openReady(index)) {
    const result = await prepareSearch(index, seconds);
    if (!result.ready)
      return { ...result, propertiesPending: true };
  }
  syncSearch(index);
  const file = searchIndexPath(index), release = acquireLock(file + ".lock");
  closeCached(index);
  const db = new Database4(file);
  tune(db);
  const start = performance.now();
  let inspected = 0, failed = 0;
  try {
    const rows = db.query(`SELECT f.id,${FULL} AS path FROM files f JOIN directories d ON d.id=f.parent WHERE f.size IS NULL AND f.mtime IS NULL AND f.dir IS NULL LIMIT ?`).all(maxFiles);
    const update = db.query("UPDATE files SET size=?,mtime=?,dir=? WHERE id=?");
    const pending = [];
    const commit = () => {
      if (!pending.length)
        return;
      db.transaction(() => {
        for (const r of pending)
          update.run(r.size, r.mtime, r.dir, r.id);
        setMeta(db, "propertiesRevision", Number(getMeta(db, "propertiesRevision")) + 1);
      })();
      pending.length = 0;
    };
    for (const r of rows) {
      if (performance.now() - start > seconds * 1000)
        break;
      try {
        const stat = fs11.statSync(r.path);
        pending.push({ id: r.id, size: stat.size, mtime: stat.mtimeMs, dir: Number(stat.isDirectory()) });
      } catch (e) {
        if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(e.code))
          throw e;
        failed++;
        pending.push({ id: r.id, size: null, mtime: null, dir: -1 });
      }
      inspected++;
      if (pending.length >= 128) {
        commit();
        await new Promise((r) => setImmediate(r));
      }
    }
    commit();
    const unknown = db.query("SELECT count(*) AS n FROM files WHERE size IS NULL OR mtime IS NULL").get().n;
    const remaining = db.query("SELECT count(*) AS n FROM files WHERE size IS NULL AND mtime IS NULL AND dir IS NULL").get().n;
    return { index, inspected, failed, unknown, pending: remaining, elapsedMs: Math.round(performance.now() - start) };
  } finally {
    db.close();
    release();
  }
}
function termGroups(pq) {
  return pq.fuzzy.map((t) => t.startsWith("'") ? [t.slice(1)] : t.split("|").filter(Boolean));
}
function matcher(pq) {
  const constraints = pq.constraints.map((c) => ({ re: new RegExp(c.pattern, "i"), negate: c.negate })), groups = termGroups(pq);
  const favorites = pq.favorites ? new Set(pq.favorites) : null;
  return (p) => (!favorites || favorites.has(p)) && !omitted(p, pq.omit) && constraints.every((c) => c.re.test(p) !== c.negate) && groups.every((g) => g.some((t) => /[A-Z]/.test(t) ? p.includes(t) : p.toLowerCase().includes(t.toLowerCase())));
}
function cachedSet(index, sql, args, active) {
  const c = connections.get(index), key = JSON.stringify([sql, args]);
  if (c.sets.has(key)) {
    const hit = c.sets.get(key);
    c.sets.delete(key);
    c.sets.set(key, hit);
    if (hit) {
      active.add(hit.table);
      return hit;
    }
    return;
  }
  const rows = () => [...c.sets.values()].reduce((n, s) => n + (s?.count || 0), 0);
  for (const [k, s] of c.sets) {
    if (rows() <= 1e6 && c.sets.size < 64)
      break;
    if (s && active.has(s.table))
      continue;
    if (s)
      c.db.exec("DROP TABLE temp." + s.table);
    c.sets.delete(k);
  }
  if (rows() > 1e6 || c.sets.size >= 64)
    return;
  const table = "fe_rows_" + ++c.sequence;
  c.db.exec("CREATE TEMP TABLE " + table + "(id INTEGER PRIMARY KEY)");
  try {
    c.db.query("INSERT INTO temp." + table + " " + sql + " LIMIT 1000001").run(...args);
    const count = directChanges(c.db);
    if (count > 1e6) {
      c.db.exec("DROP TABLE temp." + table);
      c.sets.set(key, null);
      return;
    }
    const value = { table, count };
    c.sets.set(key, value);
    active.add(table);
    return value;
  } catch (e) {
    c.db.exec("DROP TABLE IF EXISTS temp." + table);
    throw e;
  }
}
function sqlPredicate(pq, db, index, preview = false) {
  const args = [], parts = [], active = new Set;
  let omittedSet, baseTotal, baseCounter;
  const context = connections.get(index);
  const seed = (table, quoted) => {
    const key = table + quoted;
    let use = context.seeds.get(key);
    const cap = Math.min(1e5, Math.max(1e4, Math.floor(context.rows / 100)));
    if (use === undefined) {
      use = db.query(`SELECT count(*) AS n FROM (SELECT rowid FROM ${table} WHERE ${table} MATCH ? LIMIT ?)`).get(quoted, cap + 1).n <= cap;
      if (context.seeds.size >= 64)
        context.seeds.delete(context.seeds.keys().next().value);
      context.seeds.set(key, use);
    }
    return use;
  };
  if (pq.favorites) {
    if (!pq.favorites.length)
      parts.push("0");
    else {
      args.push(JSON.stringify(pq.favorites.map((p) => {
        const s = splitPath(p);
        return { parent: s.parent, name: s.name };
      })));
      parts.push("f.id IN (SELECT fav.id FROM json_each(?) saved JOIN directories folder ON folder.path=json_extract(saved.value,'$.parent') JOIN files fav ON fav.parent=folder.id AND fav.name=json_extract(saved.value,'$.name'))");
    }
  }
  const rules = omissionRules(pq.omit || []);
  const exclusions = [], excludeArgs = [];
  if (rules.length) {
    excludeArgs.push([...new Set(rules.map((r) => '"' + r.term + '"'))].join(" OR "), ...rules.map((r) => r.glob));
    exclusions.push("f.parent IN (SELECT id FROM directories WHERE id IN (SELECT rowid FROM directories_fts WHERE directories_fts MATCH ?) AND (" + rules.map(() => "pathKey GLOB ?").join(" OR ") + "))");
  }
  if (pq.omit?.includes("hidden"))
    exclusions.push("(f.nameKey GLOB '.*' OR f.parent IN (SELECT id FROM directories WHERE pathKey GLOB '*/.*'))");
  const literal = (text, exact = /[A-Z]/.test(text)) => {
    const folded = text.toLowerCase(), field = exact ? "d.path || f.name" : "d.pathKey || f.nameKey";
    if (preview) {
      const term = folded.split("/").filter((s) => [...s].length >= 3).sort((a, b) => b.length - a.length)[0];
      let pre = "";
      if (term) {
        const quoted = '"' + term.replace(/"/g, '""') + '"';
        if (seed("names_fts", quoted) && seed("directories_fts", quoted)) {
          args.push(quoted, quoted);
          pre = "(f.id IN (SELECT rowid FROM names_fts WHERE names_fts MATCH ?) OR f.parent IN (SELECT rowid FROM directories_fts WHERE directories_fts MATCH ?)) AND ";
        }
      }
      args.push(exact ? text : folded);
      return pre + `instr(${field},?)>0`;
    }
    if (!text.includes("/")) {
      const needle = exact ? text : folded, nameField = exact ? "f.name" : "f.nameKey", parentField = exact ? "path" : "pathKey";
      const quoted = '"' + folded.replace(/"/g, '""') + '"', useFts = [...folded].length >= 3;
      const directoryFts = useFts && seed("directories_fts", quoted);
      const directorySql = `SELECT id FROM directories WHERE ${directoryFts ? "id IN (SELECT rowid FROM directories_fts WHERE directories_fts MATCH ?) AND " : ""}instr(${parentField},?)>0`;
      const directoryArgs = directoryFts ? [quoted, needle] : [needle];
      const cacheKey = JSON.stringify([text, exact]);
      let directories = context.directoryCounts.get(cacheKey);
      if (directories === undefined) {
        if (!directoryFts && !exact) {
          const r = db.query("SELECT count(*) AS total,coalesce(sum(instr(pathKey,?)>0),0) AS n FROM directories INDEXED BY directory_names").get(needle);
          directories = r.n;
          context.directories = r.total;
        } else
          directories = db.query(`SELECT count(*) AS n FROM (${directorySql})`).get(...directoryArgs).n;
        if (context.directoryCounts.size >= 64)
          context.directoryCounts.delete(context.directoryCounts.keys().next().value);
        context.directoryCounts.set(cacheKey, directories);
      }
      const single = pq.fuzzy.length === 1 && termGroups(pq)[0].length === 1 && !pq.constraints.length && pq.favorites === undefined;
      if (directories === context.directories && directories > 0) {
        if (single)
          baseTotal = context.rows;
        return "1";
      }
      if (!exact && context.directories > 0 && directories > context.directories / 2 && (context.directories - directories) * context.rows / context.directories <= 1e6) {
        const missing = cachedSet(index, "SELECT f.id FROM directories v CROSS JOIN files f INDEXED BY parent_names ON f.parent=v.id WHERE instr(v.pathKey,?)=0 AND instr(f.nameKey,?)=0", [needle, needle], active);
        if (missing) {
          if (single)
            baseTotal = context.rows - missing.count;
          return "f.id NOT IN (SELECT id FROM temp." + missing.table + ")";
        }
      }
      if (single && !exact && context.directories > 0 && directories > context.directories / 10) {
        baseCounter = () => context.rows - db.query("SELECT count(*) AS n FROM directories v CROSS JOIN files f INDEXED BY parent_names ON f.parent=v.id WHERE instr(v.pathKey,?)=0 AND instr(f.nameKey,?)=0").get(needle, needle).n;
      }
      const nameFts = useFts && seed("names_fts", quoted);
      const nameSql = (nameFts ? "f.id IN (SELECT rowid FROM names_fts WHERE names_fts MATCH ?) AND " : "") + `instr(${nameField},?)>0`;
      args.push(...nameFts ? [quoted, needle] : [needle]);
      if (!directories)
        return "(" + nameSql + ")";
      if (directories > 1e4) {
        const inverse = context.directories > 0 && directories > context.directories / 2;
        const set = cachedSet(index, inverse ? `SELECT id FROM directories WHERE instr(${parentField},?)=0` : directorySql, inverse ? [needle] : directoryArgs, active);
        if (set)
          return "((" + nameSql + ") OR f.parent " + (inverse ? "NOT IN" : "IN") + " (SELECT id FROM temp." + set.table + "))";
      }
      args.push(...directoryArgs);
      return "((" + nameSql + ") OR f.parent IN (" + directorySql + "))";
    }
    const ftsTerm = text.includes("/") ? text.split("/").filter((s) => [...s].length >= 3).sort((a, b) => b.length - a.length)[0] : text;
    let pre = "";
    if (ftsTerm && [...ftsTerm].length >= 3) {
      const quoted = '"' + ftsTerm.toLowerCase().replace(/"/g, '""') + '"';
      if (seed("names_fts", quoted) && seed("directories_fts", quoted)) {
        args.push(quoted, quoted);
        pre = "(f.id IN (SELECT rowid FROM names_fts WHERE names_fts MATCH ?) OR f.parent IN (SELECT rowid FROM directories_fts WHERE directories_fts MATCH ?))";
      }
    }
    args.push(exact ? text : folded);
    return (pre ? pre + " AND " : "") + `instr(${field},?)>0`;
  };
  for (const group of termGroups(pq))
    parts.push("(" + group.map((t) => "(" + literal(t) + ")").join(" OR ") + ")");
  for (const c of pq.constraints) {
    if (c.suffixes) {
      const seeded = parts.some((p) => p.includes("names_fts") || p.includes("directories_fts"));
      const suffixes = c.suffixes.map((s) => {
        let pre = "";
        const quoted = '"' + s.replace(/"/g, '""') + '"';
        if (!seeded && [...s].length >= 3 && seed("names_fts", quoted)) {
          args.push(quoted);
          pre = "f.id IN (SELECT rowid FROM names_fts WHERE names_fts MATCH ?) AND ";
        }
        args.push("*" + s);
        return "(" + pre + "f.nameKey GLOB ?)";
      });
      parts.push("(" + suffixes.join(" OR ") + ")");
    } else if (c.literal !== undefined) {
      let test;
      if (c.field === "name") {
        const value = c.literal.toLowerCase(), useFts = [...value].length >= 3 && seed("names_fts", '"' + value.replace(/"/g, '""') + '"');
        if (useFts)
          args.push('"' + value.replace(/"/g, '""') + '"');
        args.push(value);
        test = (useFts ? "f.id IN (SELECT rowid FROM names_fts WHERE names_fts MATCH ?) AND " : "") + "instr(f.nameKey,?)>0";
      } else
        test = literal(c.literal, false);
      parts.push(c.negate ? "NOT (" + test + ")" : "(" + test + ")");
    } else if (c.alternatives)
      parts.push("(" + c.alternatives.map((t) => "(" + literal(t, false) + ")").join(" OR ") + ")");
    else
      throw new Error("Unsupported indexed constraint");
  }
  const baseSql = parts.filter((p) => p.replace(/[()\s]/g, "") !== "1").join(" AND ") || "1", baseArgs = [...args];
  if (!pq.fuzzy.length && !pq.constraints.length && pq.favorites === undefined)
    baseTotal = context.rows;
  if (exclusions.length) {
    const excluded = exclusions.join(" OR ");
    if (preview) {
      if (rules.length) {
        parts.push("NOT (" + rules.map(() => "d.pathKey GLOB ?").join(" OR ") + ")");
        args.push(...rules.map((r) => r.glob));
      }
      if (pq.omit?.includes("hidden"))
        parts.push("NOT (f.nameKey GLOB '.*' OR d.pathKey GLOB '*/.*')");
    } else {
      omittedSet = cachedSet(index, "SELECT f.id FROM files f WHERE " + excluded, excludeArgs, active);
      if (omittedSet)
        parts.push("f.id NOT IN (SELECT id FROM temp." + omittedSet.table + ")");
      else {
        parts.push("NOT (" + excluded + ")");
        args.push(...excludeArgs);
        baseTotal = undefined;
        baseCounter = undefined;
      }
    }
  }
  return { sql: parts.filter((p) => p.replace(/[()\s]/g, "") !== "1").join(" AND ") || "1", args, baseSql, baseArgs, baseTotal, baseCounter, omittedSet };
}
function searchPrepared(index, pq, limit, offset, preview = false) {
  const db = openReady(index);
  if (!db)
    return;
  db.exec("BEGIN");
  try {
    const source = getMeta(db, "source");
    if (source !== baseStamp(index))
      return;
    const liveRevision = getMeta(db, "liveRevision"), propertiesRevision = getMeta(db, "propertiesRevision");
    const context = connections.get(index), revision = `${source}:${liveRevision}:${propertiesRevision}`;
    if (context.revision !== revision) {
      const stored = getMeta(db, "indexedRows");
      context.rows = getMeta(db, "rowCountVersion") === "1" && /^\d+$/.test(stored ?? "") ? Number(stored) : db.query("SELECT count(*) AS n FROM files").get().n;
      context.directories = -1;
      for (const set of context.sets.values())
        if (set)
          db.exec("DROP TABLE temp." + set.table);
      context.directoryCounts.clear();
      context.counts.clear();
      context.sets.clear();
      context.seeds.clear();
      context.revision = revision;
    }
    preview = preview && offset === 0 && pq.favorites === undefined;
    const plan = sqlPredicate(pq, db, index, preview);
    const from = " FROM files f JOIN directories d ON d.id=f.parent WHERE " + plan.sql;
    const needsDirectories = /\bd\./.test(plan.sql), countFrom = needsDirectories ? from : " FROM files f WHERE " + plan.sql;
    const usesSize = !!pq.sizeFilter || pq.sort === "big" || pq.sort === "small", usesDate = !!pq.dmFilter || pq.sort === "new" || pq.sort === "old";
    const known = [...usesSize ? ["f.size IS NOT NULL"] : [], ...usesDate ? ["f.mtime IS NOT NULL"] : []].join(" AND ") || "1";
    const total = () => {
      const base = plan.baseTotal ?? plan.baseCounter?.();
      if (base === undefined)
        return plan.sql === "1" ? context.rows : db.query("SELECT count(*) AS n" + countFrom).get(...plan.args).n;
      if (!plan.omittedSet)
        return base;
      const excluded = plan.baseSql === "1" ? plan.omittedSet.count : db.query(`SELECT count(*) AS n FROM temp.${plan.omittedSet.table} excluded CROSS JOIN files f ON f.id=excluded.id${/\bd\./.test(plan.baseSql) ? " JOIN directories d ON d.id=f.parent" : ""} WHERE ${plan.baseSql}`).get(...plan.baseArgs).n;
      return base - excluded;
    };
    const filters = [], args = [...plan.args];
    if (pq.sizeFilter) {
      const op = pq.sizeFilter.op;
      if (op === "range") {
        filters.push("f.size BETWEEN ? AND ?");
        args.push(pq.sizeFilter.bytes, pq.sizeFilter.maxBytes);
      } else {
        const sqlOp = { "<": "<", ">": ">", "<=": "<=", ">=": ">=", "=": "=" }[op];
        if (!sqlOp)
          throw new Error("Invalid size operator");
        filters.push(`f.size ${sqlOp} ?`);
        args.push(pq.sizeFilter.bytes);
      }
    }
    const timeBucket = pq.dmFilter ? Math.floor(Date.now() / 60000) * 60000 : 0;
    if (pq.dmFilter) {
      filters.push("f.mtime>=?");
      args.push(timeBucket - pq.dmFilter.days * 86400000);
    }
    const filtered = from + (filters.length ? " AND " + filters.join(" AND ") : "");
    const countKey = JSON.stringify([plan.sql, plan.args, known, pq.sizeFilter, pq.dmFilter, timeBucket]);
    let coverage = context.counts.get(countKey);
    if (!coverage && !preview) {
      const value = { total: total(), known: 0 };
      const knownFrom = value.total > 1e4 ? countFrom.replace(" FROM files f", ` FROM files f INDEXED BY ${usesSize ? "file_size" : "file_modified"}`) : countFrom;
      value.known = known === "1" ? value.total : db.query(`SELECT count(*) AS n${knownFrom} AND ${known}`).get(...plan.args).n;
      coverage = { ...value, matched: filters.length ? db.query("SELECT count(*) AS n" + filtered).get(...args).n : value.total };
      if (context.counts.size >= 64)
        context.counts.delete(context.counts.keys().next().value);
      context.counts.set(countKey, coverage);
    }
    const matched = coverage?.matched ?? context.rows;
    const orders = { name: "f.nameKey,f.id", "name-desc": "f.nameKey DESC,f.id DESC", path: "d.pathKey,d.id,f.nameKey,f.id", "path-desc": "d.pathKey DESC,d.id DESC,f.nameKey DESC,f.id DESC", new: "f.mtime DESC,f.id DESC", old: "f.mtime ASC NULLS LAST,f.id", big: "f.size DESC,f.id DESC", small: "f.size ASC NULLS LAST,f.id" };
    const reverseOrders = { name: orders["name-desc"], "name-desc": orders.name, path: orders["path-desc"], "path-desc": orders.path, new: "f.mtime ASC,f.id", old: "f.mtime DESC NULLS FIRST,f.id DESC", big: "f.size ASC,f.id", small: "f.size DESC NULLS FIRST,f.id DESC" };
    const sort = pq.sort || "name", rankTerm = !pq.sort && pq.fuzzy.length === 1 && !pq.fuzzy[0].includes("|") ? pq.fuzzy[0].replace(/^'/, "").toLowerCase() : undefined, exactNameSql = rankTerm ? rankTerm.includes(".") ? "f.nameKey=?" : "(f.nameKey=? OR (substr(f.nameKey,1,length(?)+1)=?||'.' AND instr(substr(f.nameKey,length(?)+2),'.')=0))" : undefined, rankSql = rankTerm ? `CASE WHEN ${exactNameSql} THEN 0 WHEN substr(f.nameKey,1,length(?))=? THEN 1 WHEN instr(f.nameKey,?)>0 THEN 2 ELSE 3 END` : undefined, rankArgs = rankTerm ? rankTerm.includes(".") ? [rankTerm, rankTerm, rankTerm, rankTerm] : [rankTerm, rankTerm, rankTerm, rankTerm, rankTerm, rankTerm, rankTerm] : [], reverse = offset > matched / 2 && !rankSql, baseOrder = reverse ? reverseOrders[sort] || reverseOrders.name : orders[sort] || orders.name, order = rankSql ? `${rankSql},${orders.name}` : baseOrder;
    const pageLimit = Math.min(limit, Math.max(0, matched - offset)), pageOffset = reverse ? Math.max(0, matched - offset - pageLimit) : offset;
    const indexes = { name: "file_names", "name-desc": "file_names", big: "file_size", small: "file_size", new: "file_modified", old: "file_modified" };
    const pathOrder = pq.sort === "path" || pq.sort === "path-desc";
    let pageFrom = filtered;
    const broad = preview ? !/names_fts|directories_fts/.test(plan.sql) && !pq.sizeFilter && !pq.dmFilter : matched > Math.max(1e4, context.rows / 20);
    if (pathOrder && getMeta(db, "ordered") === "1" && broad)
      pageFrom = filtered.replace(" FROM files f JOIN directories d ON d.id=f.parent", " FROM directories d INDEXED BY directory_names CROSS JOIN files f INDEXED BY parent_names ON f.parent=d.id");
    else if (broad) {
      const indexName = indexes[pq.sort || "name"];
      if (indexName)
        pageFrom = filtered.replace(" FROM files f JOIN directories d ON d.id=f.parent", ` FROM files f INDEXED BY ${indexName} CROSS JOIN directories d ON d.id=f.parent`);
    }
    let rows;
    if (!needsDirectories && !pathOrder) {
      const filesOnly = pageFrom.replace(/ CROSS JOIN directories d ON d.id=f.parent| JOIN directories d ON d.id=f.parent/, "");
      const page = `SELECT f.id${filesOnly} ORDER BY ${order} LIMIT ? OFFSET ?`;
      rows = db.query(`SELECT ${FULL} AS path,f.size,f.mtime,f.dir FROM (${page}) page JOIN files f ON f.id=page.id JOIN directories d ON d.id=f.parent ORDER BY ${order}`).all(...args, ...rankArgs, pageLimit, pageOffset, ...rankArgs);
    } else
      rows = db.query(`SELECT ${FULL} AS path,f.size,f.mtime,f.dir${pageFrom} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, ...rankArgs, pageLimit, pageOffset);
    if (reverse)
      rows.reverse();
    if (preview)
      return {
        paths: rows.map((r) => r.path),
        properties: rows,
        offset,
        nextOffset: null,
        snapshotId: `${source}:${liveRevision}:${propertiesRevision}:${timeBucket}`,
        snapshot: true,
        complete: false,
        provisional: true,
        coverage: { indexed: context.rows, matched: null, metadataUnknown: null },
        engine: "sqlite-trigram",
        warnings: ["Exact match count is pending.", "Configured exclusions and macOS permissions apply."]
      };
    const unknown = coverage.total - coverage.known;
    return {
      paths: rows.map((r) => r.path),
      properties: rows,
      offset,
      nextOffset: offset + rows.length < matched ? offset + rows.length : null,
      snapshotId: `${source}:${liveRevision}:${propertiesRevision}:${timeBucket}`,
      snapshot: true,
      complete: unknown === 0,
      coverage: { indexed: connections.get(index).rows, matched, metadataUnknown: unknown },
      engine: "sqlite-trigram",
      warnings: [...unknown ? [`${unknown} matching paths have unknown file properties; run fe properties --index ${index}.`] : [], "Configured exclusions and macOS permissions apply."]
    };
  } catch (e) {
    try {
      if (db.inTransaction)
        db.exec("ROLLBACK");
    } finally {
      closeCached(index);
    }
    throw e;
  } finally {
    if (connections.get(index)?.db === db && db.inTransaction)
      db.exec("COMMIT");
  }
}

class PageHeap {
  capacity;
  mode;
  values = [];
  bytes = 0;
  constructor(capacity, mode = "name") {
    this.capacity = capacity;
    this.mode = mode;
  }
  compare(a, b) {
    const c = a.key < b.key ? -1 : a.key > b.key ? 1 : a.p < b.p ? -1 : a.p > b.p ? 1 : 0;
    return this.mode.endsWith("-desc") ? -c : c;
  }
  worse(a, b) {
    return this.compare(a, b) > 0;
  }
  add(p) {
    const file = p.replace(/\/$/, ""), key = this.mode.startsWith("path") ? path10.dirname(file) + "/\x00" + path10.basename(file) : path10.basename(file);
    const value = { p, key: key.toLowerCase() };
    if (this.values.length < this.capacity) {
      this.values.push(value);
      this.bytes += Buffer.byteLength(p) * 2;
      let i = this.values.length - 1;
      while (i) {
        const parent = i - 1 >> 1;
        if (!this.worse(this.values[i], this.values[parent]))
          break;
        [this.values[i], this.values[parent]] = [this.values[parent], this.values[i]];
        i = parent;
      }
    } else if (this.worse(this.values[0], value)) {
      this.bytes += Buffer.byteLength(p) * 2 - Buffer.byteLength(this.values[0].p) * 2;
      this.values[0] = value;
      let i = 0;
      while (2 * i + 1 < this.values.length) {
        let child = 2 * i + 1;
        if (child + 1 < this.values.length && this.worse(this.values[child + 1], this.values[child]))
          child++;
        if (!this.worse(this.values[child], this.values[i]))
          break;
        [this.values[child], this.values[i]] = [this.values[i], this.values[child]];
        i = child;
      }
    }
    if (this.bytes > 64 * 1024 * 1024)
      throw new Error("Result page exceeds 64 MiB; use an earlier page or narrower query");
  }
  page(offset) {
    return this.values.sort((a, b) => this.compare(a, b)).slice(offset).map((r) => r.p);
  }
}
async function searchStreaming(index, pq, limit, offset) {
  const stamp = baseStamp(index), delta = deltaFor(index), matches = matcher(pq), heap = new PageHeap(offset + limit, pq.sort), start = performance.now();
  let count = 0;
  const properties = !!pq.sizeFilter || !!pq.dmFilter || ["big", "small", "new", "old"].includes(pq.sort || "");
  const take = (p) => {
    if (!matches(p))
      return;
    count++;
    if (!pq.sizeFilter && !pq.dmFilter)
      heap.add(p);
  };
  const input = fs11.createReadStream(indexPathFor(index), { highWaterMark: 256 * 1024 }), lines = createInterface3({ input, crlfDelay: Infinity });
  try {
    let n = 0;
    for await (const p of lines) {
      if (++n % 4096 === 0 && performance.now() - start > 1e4)
        throw new Error(`Complete search exceeded 10 seconds; run fe prepare --index ${index}`);
      if (p && delta.visible(p, true))
        take(p);
    }
    for (const p of delta.additions)
      take(p);
  } finally {
    lines.close();
    input.destroy();
  }
  if (baseStamp(index) !== stamp || deltaFor(index).revision !== delta.revision)
    throw new Error("Index changed during search; restart pagination");
  const paths = heap.page(offset), matched = pq.sizeFilter || pq.dmFilter ? 0 : count;
  return {
    paths,
    offset,
    nextOffset: offset + paths.length < matched ? offset + paths.length : null,
    snapshotId: `${stamp}:${delta.revision}:stream`,
    snapshot: true,
    complete: !properties,
    coverage: { matched, metadataUnknown: properties ? count : 0 },
    engine: "complete-stream",
    warnings: [`Prepare fast indexed lookup with fe prepare --index ${index}; this search reads the existing path snapshot only.`, ...properties ? [`File properties are not indexed; run fe properties --index ${index}.`] : [], "Configured exclusions and macOS permissions apply."]
  };
}

// ../findeverything-service-20261020/src/live.ts
import { spawn as spawn4, execFile as execFile2 } from "child_process";
import { promisify as promisify2 } from "util";
import { createInterface as createInterface4 } from "readline";
import { Database as Database5 } from "bun:sqlite";
var exec2 = promisify2(execFile2);
var under = (p, root) => p === root || p.startsWith(root.endsWith("/") ? root : root + "/");
var helper = () => process.env.FE_EVENTS_HELPER || path11.join(HOME, "Applications/Find Everything.app/Contents/Helpers/fe-events");
async function startLive(names, delay = 300, canSyncSearch = () => true) {
  fs12.mkdirSync(INDEX_DIR, { recursive: true, mode: 448 });
  const binary = helper();
  if (!binary || process.platform !== "darwin")
    throw new Error("macOS fe-events helper is required for persistent incremental indexing");
  const release = acquireLock(livePath() + ".lock"), db = openLive();
  db.query("UPDATE jobs SET failures=0,retryAt=0 WHERE failures>0").run();
  let stopped = false, running = false, timer, jobsTimer;
  let child, lines;
  let scopeList = [];
  const siblings = new Map;
  const queue = new Map;
  const stop = () => {
    if (stopped)
      return;
    stopped = true;
    clearTimeout(timer);
    clearTimeout(jobsTimer);
    child?.kill("SIGKILL");
    lines?.close();
    catalogWatch?.close();
    indexWatch?.close();
    if (!running) {
      db.close();
      release();
    }
  };
  process.once("exit", stop);
  let catalogWatch, indexWatch;
  const problem = (name, text) => db.query("UPDATE scopes SET problem=? WHERE name=? AND (problem IS NULL OR problem<>?)").run(text, name, text);
  async function jobs() {
    if (stopped || running)
      return;
    running = true;
    try {
      const rows = db.query("SELECT scope,path FROM jobs WHERE failures<3 AND retryAt<=? LIMIT 8").all(Date.now());
      for (const scope of new Set(rows.map((r) => r.scope))) {
        const paths = rows.filter((r) => r.scope === scope).map((r) => r.path);
        try {
          const r = await repairMedia(scope, 8, 4, paths);
          const sounds = !r.pending ? await refreshSounds(scope, paths) : undefined;
          if (!r.pending && !sounds?.pending)
            db.transaction(() => {
              for (const p of paths)
                db.query("DELETE FROM jobs WHERE scope=? AND path=?").run(scope, p);
            })();
        } catch (e) {
          db.transaction(() => {
            for (const p of paths)
              db.query("UPDATE jobs SET failures=failures+1,retryAt=? WHERE scope=? AND path=?").run(Date.now() + 30000, scope, p);
          })();
          problem(scope, `Metadata update pending: ${e.message}`);
        }
        if (!db.query("SELECT 1 FROM jobs WHERE scope=? LIMIT 1").get(scope))
          db.query("UPDATE scopes SET problem=NULL WHERE name=? AND problem LIKE 'Metadata update pending:%'").run(scope);
      }
    } finally {
      running = false;
      if (stopped) {
        db.close();
        release();
      } else if (db.query("SELECT 1 FROM jobs WHERE failures<3 LIMIT 1").get())
        jobsTimer = setTimeout(() => void jobs(), 1000);
    }
  }
  async function accepted(p, scope) {
    const opts = effectiveOptions(scope.name), root = scope.paths.find((r) => under(p, r));
    if (!root || /[\r\n]/.test(p))
      return false;
    const relative2 = path11.relative(root, p), parts = relative2.split(path11.sep);
    const exclusions = [...BASE_EXCLUDES, ...scope.name === "all" ? ALL_EXCLUDES : [], ...(opts.extraExcludes || "").split(",").filter(Boolean)];
    if (!opts.includeHidden && parts.some((s) => s.startsWith(".")) || exclusions.some((e) => new Bun.Glob(e).match(relative2) || parts.some((part) => new Bun.Glob(e).match(part))))
      return false;
    if (opts.includeIgnored)
      return true;
    const parent = path11.dirname(p);
    const cacheKey = scope.name + ":" + parent;
    if (siblings.has(cacheKey))
      return siblings.get(cacheKey).has(p);
    try {
      const args = ["--absolute-path", "--color=never", "--print0", "--threads", "1", "--max-depth", "1", "--hidden"];
      for (const e of exclusions)
        args.push("--exclude", e);
      const task = exec2(FD, [...args, "--", "", parent], { timeout: 2000, maxBuffer: 2 * 1024 * 1024, killSignal: "SIGKILL" });
      track(task.child);
      const allowed = new Set((await task).stdout.split("\x00").map((x) => x.replace(/\/$/, "")));
      siblings.set(cacheKey, allowed);
      return allowed.has(p);
    } catch (e) {
      try {
        fs12.lstatSync(parent);
      } catch (statError) {
        if (statError.code === "ENOENT" || statError.code === "ENOTDIR")
          return false;
      }
      throw new Error(`Ignore check failed: ${e.message}`);
    }
  }
  async function subtree(p, scope) {
    const opts = effectiveOptions(scope.name), args = ["--absolute-path", "--color=never", "--print0", "--threads", "1"];
    if (opts.includeHidden)
      args.push("--hidden");
    if (opts.includeIgnored)
      args.push("--no-ignore");
    for (const e of [...BASE_EXCLUDES, ...(opts.extraExcludes || "").split(",").filter(Boolean)])
      args.push("--exclude", e);
    const task = exec2(FD, [...args, "--", "", p], { timeout: 5000, maxBuffer: 8 * 1024 * 1024, killSignal: "SIGKILL" });
    track(task.child);
    const paths = (await task).stdout.split("\x00").filter(Boolean).map((x) => x.replace(/\/$/, ""));
    if (paths.length > 20000)
      throw new Error("Changed subtree exceeds 20000 paths; explicit reconciliation required");
    return paths.filter((x) => !/[\r\n]/.test(x));
  }
  async function flush() {
    if (stopped)
      return;
    if (running) {
      timer = setTimeout(() => void flush(), delay);
      return;
    }
    running = true;
    siblings.clear();
    const batch = [...queue];
    queue.clear();
    try {
      for (const [root, message] of batch) {
        const affected = scopeList.filter((s) => s.paths.includes(root));
        const staged = [];
        const unique = new Map;
        for (const event of message.events) {
          const previous = unique.get(event.path);
          unique.set(event.path, { ...event, scopes: event.scopes && previous?.scopes ? [...new Set([...event.scopes, ...previous.scopes])] : event.scopes, flags: event.flags | (previous?.flags || 0) });
        }
        const deadline = performance.now() + 5000;
        for (const scope of affected) {
          const changes = new Map;
          let gap = message.gap;
          for (const event of unique.values()) {
            if (event.scopes && !(event.flags & (1 | 2 | 4 | 8 | 16 | 32 | 64 | 128)) && !event.scopes.includes(scope.name))
              continue;
            if (performance.now() > deadline) {
              gap = "Event processing budget exceeded; explicit reconciliation required";
              break;
            }
            const p = event.path.replace(/\/$/, "") || "/", flags = event.flags;
            if (!path11.isAbsolute(p) || !under(p, root)) {
              gap = "Invalid event path";
              continue;
            }
            if (flags & (1 | 2 | 4 | 8 | 32 | 64 | 128)) {
              gap = "Filesystem journal gap/root change; explicit reconciliation required";
              continue;
            }
            if (flags & 16 || !scope.paths.some((r) => under(p, r)))
              continue;
            const relative2 = path11.relative(scope.paths.find((r) => under(p, r)), p);
            const exclusions = [...BASE_EXCLUDES, ...scope.name === "all" ? ALL_EXCLUDES : [], ...(scope.options.extraExcludes || "").split(",").filter(Boolean)];
            if (relative2.split(path11.sep).some((part) => !scope.options.includeHidden && part.startsWith(".") || exclusions.some((e) => new Bun.Glob(e).match(part))) || exclusions.some((e) => new Bun.Glob(e).match(relative2)))
              continue;
            if ([".gitignore", ".ignore", ".fdignore"].includes(path11.basename(p))) {
              if (scope.options.includeIgnored)
                continue;
              const baseline = scope.scanStartedAt ? Date.parse(scope.scanStartedAt) : Date.parse(scope.indexedAt || "") - 120000;
              if (!fs12.existsSync(p) || fs12.statSync(p).mtimeMs >= baseline)
                gap = "Ignore rules changed; explicit reconciliation required";
              continue;
            }
            const media = /\.(mp3|wav|aac|flac|m4a|ogg|opus|aiff?|caf|wma|mp4|m4v|mov|mkv|png|jpe?g|webp)$/i.test(p);
            const propertyChange = !!(flags & (1024 | 4096)) && fs12.existsSync(searchIndexPath(scope.name));
            if (!(flags & (256 | 512 | 2048)) && !media && !propertyChange)
              continue;
            let stat;
            try {
              stat = fs12.lstatSync(p);
            } catch (e) {
              if (e.code !== "ENOENT" && e.code !== "ENOTDIR") {
                gap = `Cannot read changed path: ${e.code}`;
                continue;
              }
            }
            if (!stat) {
              changes.set(p, { present: 0, tree: flags & 131072 ? 1 : 0 });
              continue;
            }
            const prior = db.query("SELECT present FROM changes WHERE scope=? AND path=?").get(scope.name, p);
            if (propertyChange && !(flags & (256 | 512 | 2048))) {
              try {
                const old = cachedFileProperties(scope.name, p);
                const current = stat.isSymbolicLink() ? fs12.statSync(p) : stat;
                if (old?.size === current.size && old?.mtime === current.mtimeMs && old?.dir === Number(current.isDirectory()))
                  continue;
              } catch (e) {
                gap = `File property cache pending: ${String(e.message).slice(0, 300)}`;
              }
            }
            if (!stat.isDirectory() && !media && prior?.present === 1 && !propertyChange)
              continue;
            let included = false;
            try {
              included = await accepted(p, scope);
            } catch (e) {
              gap = `Ignore check failed for ${scope.name}: ${String(e.message).slice(0, 500)}`;
              continue;
            }
            if (!included) {
              try {
                fs12.lstatSync(p);
              } catch (e) {
                if (e.code === "ENOENT" || e.code === "ENOTDIR")
                  changes.set(p, { present: 0, tree: stat.isDirectory() ? 1 : 0 });
                else
                  gap = `Cannot confirm changed path: ${e.code}`;
              }
              continue;
            }
            if (stat.isDirectory() && !(flags & (256 | 2048)))
              continue;
            if (stat.isDirectory() && scope.paths.includes(p)) {
              gap = "Root directory replaced; explicit reconciliation required";
              continue;
            }
            changes.set(p, { present: 1, tree: 0 });
            if (stat.isDirectory()) {
              try {
                for (const sub of await subtree(p, scope))
                  changes.set(sub, { present: 1, tree: 0 });
              } catch (e) {
                gap = e.message;
              }
            }
          }
          const count = db.query("SELECT count(*) AS n FROM changes WHERE scope=?").get(scope.name).n;
          if (count + changes.size > 1e5) {
            gap = "Incremental overlay exceeds 100000 paths; explicit compaction required";
            changes.clear();
          }
          staged.push({ scope, changes, gap });
        }
        db.transaction(() => {
          for (const { scope, changes, gap } of staged) {
            const revision = db.query("SELECT revision FROM scopes WHERE name=?").get(scope.name).revision + 1;
            for (const [p, c] of changes) {
              db.query("INSERT INTO changes VALUES (?,?,?,?,?) ON CONFLICT(scope,path) DO UPDATE SET present=excluded.present,tree=excluded.tree,revision=excluded.revision").run(scope.name, p, c.present, c.tree, revision);
              if (fs12.existsSync(mediaPath(scope.name))) {
                if (c.tree && !c.present) {
                  const media = new Database5(mediaPath(scope.name), { readonly: true });
                  try {
                    for (const r of media.query("SELECT path FROM files WHERE substr(path,1,?)=?").all(p.length + 1, p + "/"))
                      db.query("INSERT OR IGNORE INTO jobs(scope,path) VALUES (?,?)").run(scope.name, r.path);
                  } finally {
                    media.close();
                  }
                }
                if (/\.(mp3|wav|aac|flac|m4a|ogg|opus|aiff?|caf|wma|mp4|m4v|mov|mkv|png|jpe?g|webp)$/i.test(p))
                  db.query("INSERT INTO jobs(scope,path) VALUES (?,?) ON CONFLICT(scope,path) DO UPDATE SET failures=0,retryAt=0").run(scope.name, p);
              }
            }
            if (changes.size)
              db.query("UPDATE scopes SET revision=?,lastChange=? WHERE name=?").run(revision, new Date().toISOString(), scope.name);
            if (gap)
              problem(scope.name, gap);
          }
          if ((staged.some((s) => s.changes.size || s.gap) || message.events.some((e) => e.flags & 16)) && message.cursor && message.uuid)
            db.query("INSERT INTO streams VALUES (?,?,?) ON CONFLICT(root) DO UPDATE SET uuid=excluded.uuid,cursor=excluded.cursor WHERE cursor<>excluded.cursor OR uuid<>excluded.uuid").run(root, message.uuid, message.cursor);
        })();
        for (const { scope, changes } of staged) {
          if (changes.size) {
            try {
              if (canSyncSearch())
                syncSearch(scope.name);
            } catch (e) {
              console.error(`fe: fast lookup will catch up on query: ${String(e.message).slice(0, 300)}`);
            }
            console.error(`fe: refreshed ${scope.name} incrementally (${changes.size} paths)`);
          }
        }
      }
    } catch (e) {
      for (const s of scopeList)
        problem(s.name, `Incremental update failed: ${e.message}`);
    } finally {
      running = false;
      if (stopped) {
        db.close();
        release();
      } else {
        if (queue.size)
          timer = setTimeout(() => void flush(), delay);
        jobsTimer = setTimeout(() => void jobs(), delay);
      }
    }
  }
  function configure() {
    child?.kill("SIGKILL");
    lines?.close();
    scopeList = indexStatus().filter((s) => s.exists && (!names || names.includes(s.name)));
    const roots = [...new Set(scopeList.flatMap((s) => s.paths))];
    if (roots.length > 64)
      throw new Error("At most 64 independent live roots supported");
    db.transaction(() => {
      for (const s of scopeList) {
        const stamp = baseStamp(s.name), old = db.query("SELECT stamp FROM scopes WHERE name=?").get(s.name);
        if (old?.stamp !== stamp) {
          db.query("DELETE FROM changes WHERE scope=?").run(s.name);
          db.query("DELETE FROM jobs WHERE scope=?").run(s.name);
          for (const root of s.paths)
            db.query("DELETE FROM streams WHERE root=?").run(root);
        }
        db.query("INSERT INTO scopes(name,stamp,pid) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET stamp=excluded.stamp,pid=excluded.pid,problem=CASE WHEN stamp<>excluded.stamp THEN NULL ELSE problem END").run(s.name, stamp, process.pid);
        if (s.options.includeIgnored)
          db.query("UPDATE scopes SET problem=NULL WHERE name=? AND problem='Ignore rules changed; explicit reconciliation required'").run(s.name);
      }
    })();
    if (!roots.length)
      return;
    const config = roots.map((root) => {
      const old = db.query("SELECT uuid,cursor FROM streams WHERE root=?").get(root);
      const targets = scopeList.filter((s) => s.paths.includes(root)).map((s) => ({ name: s.name, paths: s.paths, since: s.scanStartedAt ? Date.parse(s.scanStartedAt) / 1000 : Date.parse(s.indexedAt || new Date().toISOString()) / 1000 - 120 }));
      const since = Math.min(...targets.map((t) => t.since));
      return { path: root, since, ...old, targets, excludes: BASE_EXCLUDES };
    });
    child = track(spawn4(binary, [], { stdio: ["pipe", "pipe", "pipe"] }));
    child.stdin.end(JSON.stringify({ roots: config }));
    lines = createInterface4({ input: child.stdout });
    let log = "";
    child.stderr.on("data", (d) => log = (log + d).slice(-1000));
    child.on("error", (e) => {
      for (const s of scopeList)
        problem(s.name, e.message);
    });
    const current = child;
    child.on("close", (code) => {
      if (!stopped && child === current)
        for (const s of scopeList)
          problem(s.name, `Event stream stopped (${code}): ${log}`);
    });
    lines.on("line", (line) => {
      try {
        if (line.length > 1024 * 1024)
          throw new Error("Event batch too large");
        const m = JSON.parse(line);
        if (!roots.includes(m.root))
          throw new Error("Unexpected event root");
        if (m.ready)
          console.error(`fe: watching ${m.root} using persistent FSEvents`);
        const previous = queue.get(m.root), events = [...previous?.events || [], ...m.events || []];
        if (events.length > 20000) {
          events.length = 0;
          m.gap = "Event backlog exceeds budget; explicit reconciliation required";
        }
        queue.set(m.root, { uuid: m.uuid, cursor: m.cursor || previous?.cursor, gap: m.gap || previous?.gap, events });
        if (!previous)
          timer = setTimeout(() => void flush(), delay);
      } catch (e) {
        for (const s of scopeList)
          problem(s.name, e.message);
      }
    });
    jobsTimer = setTimeout(() => void jobs(), delay);
  }
  let configTimer;
  const reconfigure = () => {
    clearTimeout(configTimer);
    configTimer = setTimeout(() => {
      if (running) {
        reconfigure();
        return;
      }
      try {
        configure();
      } catch (e) {
        for (const s of scopeList)
          problem(s.name, e.message);
      }
    }, 500);
  };
  try {
    configure();
    if (fs12.existsSync(CONFIG_DIR))
      catalogWatch = fs12.watch(CONFIG_DIR, (_e, file) => {
        if (file === "indexes.json")
          reconfigure();
      });
    indexWatch = fs12.watch(INDEX_DIR, (_e, file) => {
      if (/^index-.+\.json$/.test(String(file)))
        reconfigure();
    });
  } catch (e) {
    stop();
    throw e;
  }
  return () => {
    clearTimeout(configTimer);
    stop();
  };
}

// ../findeverything-service-20261020/src/search-process.ts
import { spawn as spawn5 } from "child_process";
import path12 from "path";
var __dirname = import.meta.dir;
var searchCanceled = () => Object.assign(new Error("Search superseded or canceled"), { status: 409, code: "SEARCH_CANCELED" });
var busy = () => Object.assign(new Error("Search queue is full; retry after current requests finish"), { status: 503 });

class SearchProcess {
  launch;
  prepare;
  child;
  stopping;
  active;
  queue = [];
  clients = new Map;
  sequence = 0;
  closed = false;
  idle;
  starts = 0;
  canceled = 0;
  completed = 0;
  retiredPid;
  exit = () => this.close();
  constructor(launch = () => {
    const source = Bun.main.includes("$bunfs") ? [] : [path12.join(__dirname, "cli.ts")];
    return track(spawn5(process.execPath, [...source, "_search-worker"], {
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FE_SEARCH_WORKER: "1", FE_SEARCH_OWNER_PID: String(process.pid) }
    }));
  }, prepare = () => {}) {
    this.launch = launch;
    this.prepare = prepare;
    process.once("exit", this.exit);
  }
  canSync() {
    return !this.active && !this.stopping;
  }
  status() {
    return { pid: this.child?.pid ?? null, active: this.active ? 1 : 0, queued: this.queue.length, starts: this.starts, canceled: this.canceled, completed: this.completed, retiredPid: this.retiredPid ?? null };
  }
  advance(work) {
    if (work.client === undefined && work.generation === undefined)
      return;
    if (!work.client || !/^[a-zA-Z0-9_-]{8,64}$/.test(work.client) || !Number.isSafeInteger(work.generation) || work.generation < 0)
      throw new Error("Invalid search client or generation");
    const previous = this.clients.get(work.client);
    if (previous !== undefined && work.generation < previous)
      throw searchCanceled();
    if (previous === undefined) {
      for (const key of this.clients.keys()) {
        if (this.clients.size < 64)
          break;
        if (this.active?.work.client !== key && !this.queue.some((j) => j.work.client === key))
          this.clients.delete(key);
      }
      if (this.clients.size >= 64)
        throw busy();
    }
    this.clients.delete(work.client);
    this.clients.set(work.client, work.generation);
    for (const job of [...this.queue, ...this.active ? [this.active] : []])
      if (job.work.client === work.client && job.work.generation < work.generation)
        this.cancel(job);
  }
  search(work, signal) {
    if (this.closed)
      return Promise.reject(new Error("Search service is closing"));
    this.advance(work);
    if (signal.aborted)
      return Promise.reject(searchCanceled());
    if (work.priority === "foreground") {
      for (const job of [...this.queue, ...this.active ? [this.active] : []])
        if (job.work.client === work.client && work.client && job.work.priority === "prefetch")
          this.cancel(job);
    }
    if (this.queue.length + (this.active ? 1 : 0) >= 2)
      return Promise.reject(busy());
    return new Promise((resolve, reject) => {
      const job = { id: ++this.sequence, work, resolve, reject, cleanup: () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      } };
      const abort = () => this.cancel(job), timer = setTimeout(() => this.cancel(job, new Error("Search exceeded 12 seconds")), 12000);
      signal.addEventListener("abort", abort, { once: true });
      this.queue.push(job);
      this.drain();
    });
  }
  finish(job, error, data) {
    job.cleanup();
    if (error)
      job.reject(error);
    else
      job.resolve(data);
  }
  cancel(job, error = searchCanceled()) {
    if (this.active === job) {
      this.active = undefined;
      this.canceled++;
      this.finish(job, error);
      this.retire();
    } else {
      const i = this.queue.indexOf(job);
      if (i < 0)
        return;
      this.queue.splice(i, 1);
      this.canceled++;
      this.finish(job, error);
    }
    this.drain();
  }
  drain() {
    if (this.closed || this.active || this.stopping || !this.queue.length)
      return;
    clearTimeout(this.idle);
    const job = this.queue.shift();
    this.active = job;
    try {
      this.prepare(job.work);
      if (!this.child)
        this.start();
      this.child.stdin.write(JSON.stringify({ id: job.id, ...job.work }) + `
`, (error) => {
        if (error && this.active === job)
          this.cancel(job, error);
      });
    } catch (e) {
      this.cancel(job, e);
    }
  }
  start() {
    const child = this.launch();
    this.child = child;
    this.starts++;
    let buffer = "", errors = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (this.child !== child)
        return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 4 * 1024 ** 2) {
        if (this.active)
          this.cancel(this.active, new Error("Search response exceeds 4 MiB"));
        return;
      }
      let end;
      while ((end = buffer.indexOf(`
`)) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const reply = JSON.parse(line), job = this.active;
          if (!job || reply.id !== job.id)
            throw new Error("Invalid search worker response");
          this.active = undefined;
          this.finish(job, reply.error ? new Error(reply.error) : undefined, reply.data);
          this.completed++;
          this.idle = setTimeout(() => this.retire(), 60000);
          this.idle.unref();
          this.drain();
        } catch (e) {
          if (this.active)
            this.cancel(this.active, e);
          else
            this.retire();
          return;
        }
      }
    });
    child.stderr.on("data", (d) => {
      errors = (errors + d).slice(-2000);
    });
    child.stdin.on("error", (e) => {
      if (this.child === child && this.active)
        this.cancel(this.active, e);
    });
    child.on("error", (e) => {
      if (this.child === child && this.active)
        this.cancel(this.active, e);
    });
    child.once("close", () => {
      if (this.child !== child)
        return;
      this.child = undefined;
      if (this.active) {
        const job = this.active;
        this.active = undefined;
        this.finish(job, new Error("Search worker stopped: " + errors.slice(-400)));
      }
      this.drain();
    });
  }
  retire() {
    clearTimeout(this.idle);
    const child = this.child;
    if (!child)
      return;
    this.child = undefined;
    this.retiredPid = child.pid;
    this.stopping = new Promise((resolve) => child.once("close", resolve));
    this.stopping.then(() => {
      this.stopping = undefined;
      this.drain();
    });
    try {
      if (process.platform !== "win32" && child.pid)
        process.kill(-child.pid, "SIGKILL");
      else
        child.kill("SIGKILL");
    } catch (e) {
      if (e.code !== "ESRCH")
        throw e;
    }
  }
  close() {
    if (this.closed)
      return;
    this.closed = true;
    process.removeListener("exit", this.exit);
    for (const job of this.queue.splice(0))
      this.finish(job, searchCanceled());
    if (this.active) {
      const job = this.active;
      this.active = undefined;
      this.finish(job, searchCanceled());
    }
    this.retire();
  }
}

// ../findeverything-service-20261020/src/services.ts
import { createInterface as createInterface5 } from "readline";
var VERSION2 = "0.13.0";
async function searchFiles(query, index = defaultIndex(), limit = 300, options = {}, fresh = false, snapshot = false, offset = 0, synchronize = true, preview = false) {
  const result = await searchSnapshot(query, index, limit, options, fresh, snapshot, offset, synchronize, preview);
  const live = liveStatus(index);
  const info = indexStatus().find((i) => i.name === index), configurationChanged = info?.configurationChanged ?? false, provenanceWarnings = info?.provenanceWarnings ?? [];
  const healthy = live.watching && !live.problem && !configurationChanged;
  return {
    ...result,
    live,
    stale: healthy ? false : result.stale,
    complete: result.complete && !live.problem && !configurationChanged && !provenanceWarnings.length,
    warnings: [...result.warnings.filter((w) => !healthy || !w.startsWith("Path snapshot is old")), ...live.problem ? [live.problem] : [], ...configurationChanged ? [`Index settings changed; searching the existing snapshot. Reconcile explicitly with fe index --index ${index}.`] : [], ...provenanceWarnings]
  };
}
async function searchSnapshot(query, index, limit, options, fresh, snapshot, offset, synchronize, preview) {
  if (typeof query !== "string" || query.length > 4096)
    throw new Error("Query must be a string of at most 4096 characters");
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new Error("Limit must be an integer from 1 to 1000");
  if (!Number.isInteger(offset) || offset < 0 || offset > 1e8)
    throw new Error("Offset must be an integer from 0 to 100000000");
  const normalizedQuery = normalizeQuery(query);
  const parsed = parseQuery(normalizedQuery);
  const opts = effectiveOptions(index, options);
  const started = performance.now();
  {
    await ensureIndex(index, opts, fresh, false, snapshot);
    if (parsed.semantic)
      return { query, normalizedQuery, index, ...await searchSounds(index, parsed, limit, offset), stale: Date.now() - fs13.statSync(indexPathFor(index)).mtimeMs > Number(opts.indexMaxAgeMinutes) * 60000, elapsedMs: Math.round(performance.now() - started) };
    if (parsed.mediaFilters.length) {
      const media = searchMedia(normalizedQuery, index, parsed, limit, offset);
      const stale = Date.now() - fs13.statSync(indexPathFor(index)).mtimeMs > Number(opts.indexMaxAgeMinutes) * 60000;
      return {
        query,
        normalizedQuery,
        index,
        ...media,
        stale,
        warnings: [...media.warnings, ...stale ? [`Path snapshot is old; refresh with fe index --index ${index}`] : []],
        elapsedMs: Math.round(performance.now() - started)
      };
    }
    let prepared, acceleratorProblem;
    try {
      if (synchronize)
        syncSearch(index);
      prepared = searchPrepared(index, parsed, limit, offset, preview);
    } catch (e) {
      acceleratorProblem = `Fast lookup is unavailable; using the complete saved snapshot: ${String(e.message).slice(0, 300)}`;
    }
    if (!prepared && normalizedQuery.trim() && offset > 1e5)
      throw new Error(`Prepare fast lookup before requesting deeper pages: fe prepare --index ${index}`);
    const result = prepared ?? (!normalizedQuery.trim() ? await browse(index, limit, offset) : await searchStreaming(index, parsed, limit, offset));
    const stale = Date.now() - fs13.statSync(indexPathFor(index)).mtimeMs > Number(opts.indexMaxAgeMinutes) * 60000;
    return { query, normalizedQuery, index, ...result, warnings: [...result.warnings, ...acceleratorProblem ? [acceleratorProblem] : []], stale, elapsedMs: Math.round(performance.now() - started) };
  }
}
async function serveSearchWorker() {
  if (process.env.FE_SEARCH_WORKER !== "1" || Number(process.env.FE_SEARCH_OWNER_PID) !== process.ppid)
    throw new Error("Search worker requires its owning service");
  const lines = createInterface5({ input: process.stdin, crlfDelay: Infinity });
  const ownerPid = process.ppid;
  const owner = setInterval(() => {
    try {
      if (process.ppid !== ownerPid)
        process.exit(0);
      process.kill(ownerPid, 0);
    } catch {
      process.exit(0);
    }
  }, 1000);
  owner.unref();
  try {
    for await (const line of lines) {
      if (Buffer.byteLength(line) > 32768)
        throw new Error("Search request exceeds limit");
      const request = JSON.parse(line);
      let reply;
      try {
        if (!Number.isSafeInteger(request.id) || !fs13.existsSync(indexPathFor(request.index)))
          throw new Error("No saved index; create it explicitly before searching");
        const data = await searchFiles(request.query, request.index, request.limit, {}, false, true, request.offset, false, request.phase === "preview");
        reply = { id: request.id, data };
      } catch (e) {
        reply = { id: request.id, error: String(e.message).slice(0, 1000) };
      }
      let body = JSON.stringify(reply) + `
`;
      if (Buffer.byteLength(body) > 4 * 1024 ** 2)
        body = JSON.stringify({ id: request.id, error: "Search response exceeds 4 MiB" }) + `
`;
      if (!process.stdout.write(body))
        await new Promise((resolve) => process.stdout.once("drain", resolve));
    }
  } finally {
    clearInterval(owner);
    closeSoundWorker();
  }
}
function equalToken(actual, expected) {
  const a = Buffer.from(actual), b = Buffer.from(`Bearer ${expected}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
function createApi(token, localSocket = false) {
  if (token.length < 32)
    throw new Error("FE_API_TOKEN must contain at least 32 characters");
  let active = 0;
  let refreshing = false;
  const reader = new SearchProcess(undefined, (work) => {
    const parsed = parseQuery(normalizeQuery(work.query));
    if (!parsed.semantic && !parsed.mediaFilters.length)
      syncSearch(work.index);
  });
  const cache = new Map;
  let cacheBytes = 0;
  const cachedSearch = async (work, signal) => {
    reader.advance(work);
    const { query, index, limit, offset } = work;
    if (typeof query !== "string" || query.length > 4096)
      throw new Error("Query must be a string of at most 4096 characters");
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new Error("Limit must be an integer from 1 to 1000");
    if (!Number.isInteger(offset) || offset < 0 || offset > 1e8)
      throw new Error("Offset must be an integer from 0 to 100000000");
    if (work.priority && !["foreground", "prefetch"].includes(work.priority))
      throw new Error("Invalid search priority");
    if (work.phase && work.phase !== "preview")
      throw new Error("Invalid search phase");
    const normalizedQuery = normalizeQuery(query);
    const started = performance.now();
    const fingerprint = (file) => {
      try {
        const s = fs13.statSync(file);
        return [s.mtimeMs, s.size];
      } catch (e) {
        if (e.code === "ENOENT")
          return null;
        throw e;
      }
    };
    const key = JSON.stringify([query, index, limit, offset, work.phase, effectiveOptions(index), fingerprint(indexPathFor(index)), fingerprint(searchIndexPath(index)), fingerprint(mediaPath(index)), fingerprint(semanticPath(index)), fingerprint(livePath()), /\b(?:favorites|fav|is|type):/i.test(normalizedQuery) ? fingerprint(favoritesFile()) : null]);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 2000)
      return { ...hit.data, elapsedMs: Math.round(performance.now() - started), cacheHit: true };
    if (hit) {
      cache.delete(key);
      cacheBytes -= hit.bytes;
    }
    const data = await reader.search(work, signal);
    const bytes = Buffer.byteLength(JSON.stringify(data));
    if (bytes <= 256 * 1024) {
      while (cache.size && (cache.size >= 64 || cacheBytes + bytes > 4 * 1024 * 1024)) {
        const oldest = cache.keys().next().value;
        cacheBytes -= cache.get(oldest).bytes;
        cache.delete(oldest);
      }
      const previous = cache.get(key);
      if (previous)
        cacheBytes -= previous.bytes;
      cache.set(key, { at: Date.now(), data, bytes });
      cacheBytes += bytes;
    }
    return { ...data, cacheHit: false };
  };
  const server = http2.createServer(async (req, res) => {
    const send = (status, data) => {
      if (res.destroyed)
        return;
      const body = JSON.stringify(data);
      res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(body);
    };
    const address = server.address();
    const host = localSocket ? "localhost" : typeof address === "object" && address ? `127.0.0.1:${address.port}` : "";
    if (req.headers.host !== host || req.headers.origin)
      return send(403, { error: "Local non-browser requests only" });
    if (!equalToken(req.headers.authorization || "", token))
      return send(401, { error: "Bearer token required" });
    if (req.headers["transfer-encoding"] || Number(req.headers["content-length"] || "0") > 0) {
      req.resume();
      return send(413, { error: "Request bodies are not supported" });
    }
    if (active >= 8)
      return send(503, { error: "Busy; retry after current requests finish" });
    active++;
    try {
      const url = new URL(req.url || "/", `http://${host}`);
      if (url.origin !== `http://${host}`)
        return send(403, { error: "Invalid request origin" });
      if (req.method === "GET" && url.pathname === "/health")
        return send(200, { version: VERSION2, apiRevision: 6, ok: true, search: reader.status() });
      if (req.method === "GET" && url.pathname === "/v1/indexes")
        return send(200, indexStatus().map((i) => ({ ...i, live: i.exists ? liveStatus(i.name) : null })));
      if (req.method === "GET" && url.pathname === "/v1/updates") {
        const index = url.searchParams.get("index") || defaultIndex();
        const fingerprint = (p) => fs13.existsSync(p) ? fs13.statSync(p).mtimeMs : null;
        const live = liveStatus(index);
        return send(200, { ...live, revision: JSON.stringify([fingerprint(indexPathFor(index)), live.revision, fingerprint(searchIndexPath(index)), fingerprint(mediaPath(index)), fingerprint(semanticPath(index))]) });
      }
      if (req.method === "GET" && url.pathname === "/v1/query-help")
        return send(200, QUERY_HELP);
      if (req.method === "GET" && url.pathname === "/v1/search") {
        const cancel = new AbortController, abort = () => {
          if (!res.writableFinished)
            cancel.abort();
        };
        res.once("close", abort);
        try {
          return send(200, await cachedSearch({ query: url.searchParams.get("q") || "", index: url.searchParams.get("index") || defaultIndex(), limit: Number(url.searchParams.get("limit") || "300"), offset: Number(url.searchParams.get("offset") || "0"), client: url.searchParams.get("client") ?? undefined, generation: url.searchParams.has("generation") ? Number(url.searchParams.get("generation")) : undefined, priority: url.searchParams.get("priority") || "foreground", phase: url.searchParams.get("phase") ?? undefined }, cancel.signal));
        } finally {
          res.removeListener("close", abort);
        }
      }
      const refresh = url.pathname.match(/^\/v1\/indexes\/([a-zA-Z0-9_-]+)\/refresh$/);
      if (req.method === "POST" && refresh) {
        if (refreshing)
          return send(503, { error: "An explicit index refresh is already running" });
        refreshing = true;
        try {
          await rebuildIndex(refresh[1], {});
          return send(200, indexStatus().find((i) => i.name === refresh[1]));
        } finally {
          refreshing = false;
        }
      }
      return send(404, { error: "Unknown endpoint" });
    } catch (e) {
      send(e.status || 400, { error: e.message, ...e.code ? { code: e.code } : {} });
    } finally {
      active--;
    }
  });
  server.once("close", () => reader.close());
  server.requestTimeout = 15000;
  server.headersTimeout = 5000;
  server.maxRequestsPerSocket = 100;
  return Object.assign(server, { canSyncSearch: () => reader.canSync() });
}
async function serveApi(port, socketPath, idleSeconds = 300, parentBound = false, live = false) {
  const token = process.env.FE_API_TOKEN || randomBytes(32).toString("hex");
  const server = createApi(token, !!socketPath);
  server.once("close", closeSoundWorker);
  let idleTimer;
  const resetIdle = () => {
    if (live)
      return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => server.close(), idleSeconds * 1000);
    idleTimer.unref();
  };
  server.on("request", resetIdle);
  server.on("close", () => clearTimeout(idleTimer));
  if (!live)
    resetIdle();
  const stopLive = live ? await startLive(undefined, 300, server.canSyncSearch) : undefined;
  server.once("close", () => stopLive?.());
  const ownerPid = parentBound ? process.ppid : undefined;
  if (ownerPid) {
    const ownerTimer = setInterval(() => {
      try {
        process.kill(ownerPid, 0);
      } catch {
        server.close();
      }
    }, 1000);
    ownerTimer.unref();
    server.once("close", () => clearInterval(ownerTimer));
  }
  if (socketPath) {
    await listenSocket(server, socketPath, token, VERSION2, ownerPid);
    return;
  }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const bound = server.address();
  console.error(JSON.stringify({ url: `http://127.0.0.1:${bound.port}`, token }));
}
var tools = [
  { name: "search_files", description: "Search complete indexed filenames/paths with exact coverage.matched counts, stable pages and global sort:name|path|big|small|new|old. Pass nextOffset as offset and retain snapshotId; never assume the first page is the whole result set. Size/date require cached properties; unknown metadata and index gaps keep complete false. German audio filters and parenthesized local CLAP sound descriptions are supported; acoustic ranking is approximate. No query-time directory scan.", inputSchema: { type: "object", properties: { query: { type: "string", maxLength: 4096 }, index: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 1000 }, offset: { type: "integer", minimum: 0, maximum: 1e8 } }, required: ["query"], additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "prepare_index", description: "Compile the fast filename lookup from an existing path snapshot, without traversing folders. Bounded and resumable; call again if ready=false. No permission changes.", inputSchema: { type: "object", properties: { index: { type: "string" }, seconds: { type: "integer", minimum: 1, maximum: 30 } }, required: ["index"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "index_properties", description: "Cache file size and modification date from known indexed paths in a bounded batch. No file content decoding or directory traversal. Repeat while pending>0; failed paths stay unknown.", inputSchema: { type: "object", properties: { index: { type: "string" }, maxFiles: { type: "integer", minimum: 1, maximum: 1e4 }, seconds: { type: "integer", minimum: 1, maximum: 30 } }, required: ["index"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "list_indexes", description: "List configured folder/project indexes and their freshness.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "refresh_index", description: "Rebuild a configured path index. Does not extract media metadata. User files remain unchanged.", inputSchema: { type: "object", properties: { index: { type: "string" } }, required: ["index"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "query_help", description: "Supported single-line query syntax, media fields, examples and coverage limits.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } }
];
function mcpSession() {
  let initialized = false, ready = false;
  return async (message) => {
    const id = message?.id ?? null;
    const error = (code, text) => ({ jsonrpc: "2.0", id, error: { code, message: text } });
    if (!message || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string" || "id" in message && typeof message.id !== "string" && typeof message.id !== "number")
      return error(-32600, "Invalid Request");
    const notify = !("id" in message);
    if (notify) {
      if (message.method === "notifications/initialized" && initialized)
        ready = true;
      return;
    }
    let result;
    switch (message.method) {
      case "initialize": {
        if (initialized)
          return error(-32600, "Already initialized");
        if (!message.params || typeof message.params.protocolVersion !== "string" || !message.params.clientInfo || typeof message.params.capabilities !== "object")
          return error(-32602, "Invalid initialization parameters");
        initialized = true;
        const supported = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
        result = { protocolVersion: supported.includes(message.params.protocolVersion) ? message.params.protocolVersion : supported[0], capabilities: { tools: {} }, serverInfo: { name: "find-everything", version: VERSION2 } };
        break;
      }
      case "ping":
        result = {};
        break;
      case "tools/list":
        if (!ready)
          return error(-32000, "Initialize the session first");
        result = { tools };
        break;
      case "tools/call": {
        if (!ready)
          return error(-32000, "Initialize the session first");
        const params = message.params;
        const tool = tools.find((t) => t.name === params?.name);
        if (!tool)
          return error(-32602, "Unknown tool");
        const args = params.arguments || {};
        if (!args || typeof args !== "object" || Array.isArray(args))
          return error(-32602, "Arguments must be an object");
        const keys = Object.keys(tool.inputSchema.properties);
        if (Object.keys(args).some((k) => !keys.includes(k)) || "index" in args && typeof args.index !== "string" || params.name === "search_files" && typeof args.query !== "string" || params.name === "refresh_index" && typeof args.index !== "string")
          return error(-32602, "Invalid tool arguments");
        try {
          let data;
          if (params.name === "search_files")
            data = await searchFiles(args.query, args.index || defaultIndex(), args.limit ?? 300, {}, false, true, args.offset ?? 0);
          else if (params.name === "list_indexes")
            data = { indexes: indexStatus() };
          else if (params.name === "query_help")
            data = QUERY_HELP;
          else if (params.name === "prepare_index" || params.name === "index_properties") {
            if (typeof args.index !== "string" || !fs13.existsSync(indexPathFor(args.index)))
              throw new Error("Existing indexed scope required; create a snapshot explicitly with fe index");
            const seconds = args.seconds ?? 10, maxFiles = args.maxFiles ?? 1000;
            if (!Number.isInteger(seconds) || seconds < 1 || seconds > 30 || !Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 1e4)
              throw new Error("Invalid preparation budget");
            data = params.name === "prepare_index" ? await prepareSearch(args.index, seconds) : await indexProperties(args.index, maxFiles, seconds);
          } else {
            await rebuildIndex(args.index, {});
            data = indexStatus().find((i) => i.name === args.index);
          }
          result = { content: [{ type: "text", text: JSON.stringify(data) }] };
        } catch (e) {
          result = { content: [{ type: "text", text: e.message }], isError: true };
        }
        break;
      }
      default:
        return error(-32601, "Method not found");
    }
    return { jsonrpc: "2.0", id, result };
  };
}
async function serveMcp() {
  const handle = mcpSession();
  let buffer = "", queued = 0;
  let work = Promise.resolve();
  const send = (value) => process.stdout.write(JSON.stringify(value) + `
`);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 1024 * 1024) {
      console.error("fe mcp: message limit exceeded");
      process.exit(1);
    }
    let end;
    while ((end = buffer.indexOf(`
`)) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim())
        continue;
      if (++queued > 32) {
        console.error("fe mcp: request queue limit exceeded");
        process.exit(1);
      }
      work = work.then(async () => {
        let request;
        try {
          request = JSON.parse(line);
        } catch {
          send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
          return;
        }
        const response = await handle(request);
        if (response)
          send(response);
      }).catch((e) => {
        console.error(`fe mcp: ${e.message}`);
        process.exitCode = 1;
      }).finally(() => {
        queued--;
      });
    }
  });
  process.stdin.on("end", () => {
    if (buffer.trim())
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Incomplete message" } });
    work.finally(closeSoundWorker);
  });
}

// ../findeverything-service-20261020/src/combine.ts
import { Database as Database6 } from "bun:sqlite";
import * as fs14 from "fs";
import path13 from "path";
import { once } from "events";
function cloneSnapshot(source, destination) {
  const db = new Database6(source, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout=1000; BEGIN");
    db.query("SELECT name FROM sqlite_master LIMIT 1").get();
    if (db.query("PRAGMA journal_mode").get().journal_mode !== "delete")
      throw new Error("Snapshot cloning requires a checkpointed source");
    try {
      fs14.copyFileSync(source, destination, fs14.constants.COPYFILE_FICLONE_FORCE);
    } catch (e) {
      if (!["ENOTSUP", "ENOSYS", "EXDEV", "EINVAL"].includes(e.code))
        throw e;
      fs14.copyFileSync(source, destination);
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}
function combineStores(sources, destination, tables) {
  const donors = sources.filter(fs14.existsSync).sort((a, b) => fs14.statSync(b).size - fs14.statSync(a).size);
  if (!donors.length)
    return;
  const stage = destination + ".combine";
  for (const suffix of ["", "-wal", "-shm"])
    fs14.rmSync(stage + suffix, { force: true });
  cloneSnapshot(donors[0], stage);
  const db = new Database6(stage);
  try {
    db.exec("PRAGMA busy_timeout=1000; PRAGMA cache_size=-8192;");
    for (const donor of donors.slice(1)) {
      db.query("ATTACH DATABASE ? AS incoming").run(donor);
      try {
        for (const table of tables) {
          const target = db.query(`PRAGMA main.table_info(${table})`).all(), source = db.query(`PRAGMA incoming.table_info(${table})`).all();
          const columns = target.filter((t) => source.some((s) => s.name === t.name)).map((t) => '"' + t.name.replace(/"/g, '""') + '"');
          if (columns.length)
            db.exec(`INSERT OR IGNORE INTO main.${table}(${columns.join(",")}) SELECT ${columns.join(",")} FROM incoming.${table}`);
        }
      } finally {
        db.exec("DETACH DATABASE incoming");
      }
    }
  } finally {
    db.close();
  }
  fs14.renameSync(stage, destination);
}
async function combineIndexes(name, sourceNames = [], replace = false, seconds = 300) {
  validateName(name);
  if (BUILTIN_SCOPES.includes(name))
    throw new Error("Choose a named combined index, such as everything");
  const old = profiles().find((p) => p.name === name);
  if (old && !replace)
    throw new Error("Combined index already exists; use --replace to rebuild it from saved snapshots");
  const sources = indexStatus().filter((s) => s.exists && s.name !== name && (!sourceNames.length || sourceNames.includes(s.name)));
  if (!sources.length || sources.length > 64)
    throw new Error("Combine 1\u201364 existing indexes");
  if (sourceNames.some((n) => !sources.some((s) => s.name === n)))
    throw new Error("A source index is missing");
  const deadline = performance.now() + seconds * 1000;
  const sizes = new Map;
  for (const source of sources) {
    const prepared = await prepareSearch(source.name, Math.min(20, seconds));
    if (!prepared.ready)
      throw new Error(`Continue fe prepare --index ${source.name} first`);
    sizes.set(source.name, fs14.statSync(searchIndexPath(source.name)).size);
  }
  sources.sort((a, b) => sizes.get(b.name) - sizes.get(a.name));
  const profile = { name, paths: canonicalPaths(sources.flatMap((s) => s.paths)), includeHidden: true, includeIgnored: true, indexMaxAgeMinutes: "60" };
  const file = indexPathFor(name), lookup = searchIndexPath(name), stage = lookup + ".combine", flat = file + ".combine", metadata = path13.join(INDEX_DIR, `index-${name}.json`);
  const release = acquireLock(file + ".lock");
  let db, output, publishRelease;
  const modified = (file) => fs14.existsSync(file) ? fs14.statSync(file).mtimeMs : null;
  try {
    const descriptor = sources.map((s) => ({ name: s.name, mtime: modified(searchIndexPath(s.name)), size: fs14.statSync(searchIndexPath(s.name)).size, media: modified(mediaPath(s.name)), sound: modified(semanticPath(s.name)) }));
    if (old && fs14.existsSync(metadata) && JSON.stringify(JSON.parse(fs14.readFileSync(metadata, "utf8")).combinedSources) === JSON.stringify(descriptor) && searchIndexStatus(name).ready)
      return { ...searchIndexStatus(name), reused: true, filesystemScan: false };
    for (const suffix of ["", "-wal", "-shm"])
      fs14.rmSync(stage + suffix, { force: true });
    cloneSnapshot(searchIndexPath(sources[0].name), stage);
    db = new Database6(stage);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-16384; PRAGMA temp_store=MEMORY;");
    for (const source of sources.slice(1)) {
      if (performance.now() > deadline)
        throw new Error("Combination budget reached; source indexes and the previous combined view are preserved");
      db.query("ATTACH DATABASE ? AS incoming").run(searchIndexPath(source.name));
      try {
        db.transaction(() => {
          db.exec(`INSERT OR IGNORE INTO directories(path,pathKey) SELECT path,pathKey FROM incoming.directories;
            INSERT OR IGNORE INTO files(parent,name,nameKey,slash,size,mtime,dir)
            SELECT target.id,f.name,f.nameKey,f.slash,f.size,f.mtime,f.dir FROM incoming.files f
            JOIN incoming.directories source ON source.id=f.parent JOIN main.directories target ON target.path=source.path;`);
          const update = db.query("UPDATE main.files SET size=?,mtime=?,dir=coalesce(dir,?) WHERE parent=(SELECT id FROM main.directories WHERE path=?) AND name=? AND size IS NULL AND mtime IS NULL");
          for (const r of db.query("SELECT d.path AS parent,f.name,f.size,f.mtime,f.dir FROM incoming.files f JOIN incoming.directories d ON d.id=f.parent WHERE f.size IS NOT NULL AND f.mtime IS NOT NULL").iterate())
            update.run(r.size, r.mtime, r.dir, r.parent, r.name);
        })();
      } finally {
        db.exec("DETACH DATABASE incoming");
      }
      if (fs14.statSync(stage).size > 6 * 1024 ** 3)
        throw new Error("Combined accelerator exceeds 6 GiB; select fewer source indexes");
      console.error(`fe: combined saved index ${source.name}`);
      await new Promise((r) => setImmediate(r));
    }
    let bytes = 0, count = 0, chunk = "";
    output = fs14.createWriteStream(flat, { mode: 384 });
    const written = once(output, "finish");
    for (const r of db.query("SELECT d.path || f.name || CASE WHEN f.slash=1 THEN '/' ELSE '' END AS path FROM files f JOIN directories d ON d.id=f.parent ORDER BY f.id").iterate()) {
      chunk += r.path + `
`;
      count++;
      if (chunk.length >= 128 * 1024) {
        bytes += Buffer.byteLength(chunk);
        if (!output.write(chunk))
          await once(output, "drain");
        chunk = "";
        if (performance.now() > deadline)
          throw new Error("Combined snapshot publication budget reached");
      }
    }
    if (chunk) {
      bytes += Buffer.byteLength(chunk);
      output.write(chunk);
    }
    output.end();
    await written;
    output = undefined;
    const fd = fs14.openSync(flat, "r");
    try {
      fs14.fsyncSync(fd);
    } finally {
      fs14.closeSync(fd);
    }
    publishRelease = acquireLock(lookup + ".lock");
    fs14.renameSync(flat, file);
    const stat = fs14.statSync(file);
    const put = db.query("INSERT OR REPLACE INTO meta VALUES (?,?)");
    db.transaction(() => {
      for (const [key, value] of Object.entries({ source: `${stat.mtimeMs}:${stat.size}`, ready: "1", liveRevision: "0", propertiesRevision: "1", indexedRows: String(count), rowCountVersion: "1", combinedSources: JSON.stringify(descriptor) }))
        put.run(key, value);
    })();
    db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
    db.close();
    db = undefined;
    fs14.renameSync(stage, lookup);
    combineStores(sources.map((s) => mediaPath(s.name)), mediaPath(name), ["files"]);
    combineStores(sources.map((s) => semanticPath(s.name)), semanticPath(name), ["vectors", "aliases"]);
    const warnings = ["Combined saved indexes: source coverage gaps and excluded locations remain; no filesystem traversal was performed."];
    const data = snapshotDescription(name, profile, count, bytes, warnings);
    fs14.writeFileSync(metadata + ".tmp", JSON.stringify({ ...data, combinedSources: descriptor }), { mode: 384 });
    fs14.renameSync(metadata + ".tmp", metadata);
    saveProfile(profile, replace);
    return { index: name, ready: true, rows: count, bytes, sources: descriptor.map((s) => s.name), roots: profile.paths, filesystemScan: false };
  } finally {
    output?.destroy();
    db?.close();
    publishRelease?.();
    release();
    fs14.rmSync(flat, { force: true });
  }
}

// ../findeverything-service-20261020/src/cli.ts
var stopLive;
var setupProcess;
function stopSetup() {
  const child = setupProcess;
  setupProcess = undefined;
  if (!child?.pid || child.exitCode !== null)
    return;
  try {
    if (process.platform !== "win32")
      process.kill(-child.pid, "SIGKILL");
    else
      child.kill("SIGKILL");
  } catch (e) {
    if (e.code !== "ESRCH")
      throw e;
  }
}
function numeric(value, name, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max)
    throw new Error(`${name} must be ${min}\u2013${max}`);
  return n;
}
function parseFlags(argv) {
  const flags = {
    paths: [],
    opts: {},
    limit: 300,
    json: false,
    nul: false,
    tui: false,
    fresh: false,
    replace: false,
    names: false,
    port: 39217,
    interval: 1,
    help: false,
    version: false,
    snapshot: false,
    maxFiles: 500,
    seconds: 60,
    kind: "audio",
    idleSeconds: 300,
    offset: 0,
    parentBound: false,
    query: "",
    rows: 1e7,
    sources: []
  };
  const pos = [];
  for (let i = 0;i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (!argv[i + 1] || argv[i + 1].startsWith("--"))
        throw new Error(`Missing value for ${a}`);
      return argv[++i];
    };
    switch (a) {
      case "--":
        pos.push(...argv.slice(i + 1));
        i = argv.length;
        break;
      case "--scope":
      case "--index":
      case "-s":
        flags.scope = value();
        break;
      case "--path":
        flags.paths.push(value());
        break;
      case "--name":
        flags.name = value();
        break;
      case "--limit":
      case "-n":
        flags.limit = numeric(value(), a, 1, 1000);
        if (!Number.isInteger(flags.limit))
          throw new Error("Limit must be an integer");
        break;
      case "--max-age":
        flags.opts.indexMaxAgeMinutes = String(numeric(value(), a, 1, 10080));
        break;
      case "--exclude":
        flags.opts.extraExcludes = [flags.opts.extraExcludes, value()].filter(Boolean).join(",");
        break;
      case "--hidden":
        flags.opts.includeHidden = true;
        break;
      case "--no-hidden":
        flags.opts.includeHidden = false;
        break;
      case "--include-ignored":
        flags.opts.includeIgnored = true;
        break;
      case "--respect-ignore":
        flags.opts.includeIgnored = false;
        break;
      case "--preset": {
        flags.preset = value();
        if (!["project", "folder"].includes(flags.preset))
          throw new Error("Preset must be project or folder");
        break;
      }
      case "--json":
        flags.json = true;
        break;
      case "--null":
      case "-0":
        flags.nul = true;
        break;
      case "--tui":
        flags.tui = true;
        break;
      case "--fresh":
        flags.fresh = true;
        break;
      case "--snapshot":
        flags.snapshot = true;
        break;
      case "--socket": {
        const p = value();
        flags.socket = p === "auto" ? DEFAULT_SOCKET : path14.resolve(p);
        break;
      }
      case "--max-files":
        flags.maxFiles = numeric(value(), a, 1, 1e4);
        break;
      case "--rows":
        flags.rows = numeric(value(), a, 1, 1e7);
        if (!Number.isInteger(flags.rows))
          throw new Error("Rows must be an integer");
        break;
      case "--sources":
        flags.sources = value().split(",").filter(Boolean);
        break;
      case "--seconds":
        flags.seconds = numeric(value(), a, 1, 300);
        break;
      case "--kind":
        flags.kind = value();
        break;
      case "--idle-seconds":
        flags.idleSeconds = numeric(value(), a, 1, 3600);
        break;
      case "--offset":
        flags.offset = numeric(value(), a, 0, 1e8);
        break;
      case "--parent":
        flags.parentBound = true;
        break;
      case "--live":
        flags.live = true;
        break;
      case "--query":
        flags.query = value();
        break;
      case "--replace":
        flags.replace = true;
        break;
      case "--names":
        flags.names = true;
        break;
      case "--port":
        flags.port = numeric(value(), a, 0, 65535);
        if (!Number.isInteger(flags.port))
          throw new Error("Port must be an integer");
        break;
      case "--interval":
        flags.interval = numeric(value(), a, 0.2, 60);
        break;
      case "--help":
      case "-h":
        flags.help = true;
        break;
      case "--version":
      case "-v":
        flags.version = true;
        break;
      default:
        if (a.startsWith("-"))
          throw new Error(`Unknown option: ${a}`);
        pos.push(a);
    }
  }
  if (flags.preset)
    flags.opts = { includeHidden: true, includeIgnored: flags.preset === "folder", ...flags.opts };
  if (flags.json && (flags.nul || flags.tui))
    throw new Error("--json cannot be combined with --null or --tui");
  return { pos, flags };
}
var HELP = `fe \u2014 Find Everything ${VERSION2}

  fe [search] <query>             ranked paths; no command opens the picker
  fe index [folder ...]          rebuild a scope, folder or project index
  fe indexes                     list built-in and saved indexes
  fe indexes remove <name>       forget a profile (keeps files and cache)
  fe watch --index <name>        incremental journal updates; foreground
  fe prepare --index NAME       compile fast search from existing path data
  fe combine --name everything  merge saved indexes without a directory scan
  fe properties --index NAME    cache file size/date; no directory traversal
  fe status [--json]             tools and index health
  fe open|reveal|preview <path>   OS actions or bounded text preview
  fe completions bash|zsh|fish    print shell completion script
  fe serve [--port 39217]        token-protected HTTP API on 127.0.0.1
  fe mcp                        MCP server over stdio
  fe enrich --index NAME        extract changed media metadata, within a budget
  fe repair-media --index NAME  retry unknown audio once per reader/file version
  fe query-help                 single-line smart fields and examples
  fe favorites list|add|remove  shared favorite paths (absolute paths for add/remove)
  fe semantic setup             install pinned local CLAP runtime and model
  fe semantic status            show model readiness and location
  fe semantic index --index NAME --query '(kurze Lasersounds)' --max-files 100 --seconds 60

  --index, --scope, -s <name>    home|downloads|documents|applications|all|custom|saved
  --path <folder>                repeat for multiple roots
  --name <name> --replace        save or explicitly update a profile
  --preset project|folder        project respects ignore files; folder includes them
  --hidden | --no-hidden         include/exclude dotfiles
  --include-ignored              bypass ignore files (build/cache exclusions remain)
  --exclude <glob>               repeatable extra exclusion
  --max-age <minutes>            snapshot age warning threshold (default 60)
  --fresh                       force refresh before searching
  --snapshot                    use existing snapshot (also the default)
  --live                        serve maintains journal deltas until stopped
  --socket auto|<path>           private Unix socket for serve or search
  --kind audio|video|image|media enrichment kind (default audio)
  --max-files <1\u201310000>          enrichment probe budget (default 500)
  --seconds <1\u2013300>              enrichment wall-time budget (default 60)
  --rows <1\u201310000000>           preparation checkpoint budget; safe to resume
  --sources NAME,NAME           choose combine sources (default: all saved)
  --idle-seconds <1\u20133600>        serve exits after idle time (default 300)
  --offset <0\u2013100000000>        result page; deep filtered pages need prepare
  --parent                      serve exits when its calling process exits
  -n, --limit <1\u20131000>           result limit (default 300)
  --json | -0, --null            JSON or NUL-separated paths
  --interval <seconds>           watcher debounce, 0.2\u201360 (default 1)
  --help, -h | --version, -v

Examples:
  fe index ~/BASE/projects/hypersearch --name hypersearch --preset project
  fe search 'engine ext:ts' --index hypersearch --json
  fe search 'invoice ext:pdf' --path ~/Documents/Invoices

Indexes store paths; fe enrich adds media properties with ffprobe. No full-text index.
`;
function selection(flags) {
  if (flags.paths.length) {
    if (flags.scope)
      throw new Error("Use either --path or --index, not both");
    const paths = canonicalPaths(flags.paths);
    const opts = { includeHidden: true, includeIgnored: false, ...flags.opts, paths };
    return { scope: pathIndexName(paths, opts), opts };
  }
  const scope = flags.scope || defaultIndex();
  return { scope, opts: effectiveOptions(scope, flags.opts) };
}
async function cmdSearch(q, flags) {
  const { scope, opts } = selection(flags);
  if (flags.socket && (flags.paths.length || flags.fresh || Object.keys(flags.opts).length))
    throw new Error("Socket searches use saved index settings; refresh separately or omit --socket");
  const result = flags.socket ? await socketRequest(flags.socket, `/v1/search?${new URLSearchParams({ q, index: scope, limit: String(flags.limit), offset: String(flags.offset) })}`) : await searchFiles(q, scope, flags.limit, opts, flags.fresh, flags.snapshot, flags.offset).finally(closeSoundWorker);
  if (flags.json)
    return void console.log(JSON.stringify(result));
  for (const warning of result.warnings || [])
    console.error(`fe: ${warning}`);
  for (const p of result.paths)
    process.stdout.write(flags.tui ? `${p}	${path14.basename(p)}  ${path14.dirname(p).replace(HOME, "~")}
` : p + (flags.nul ? "\x00" : `
`));
}
async function cmdIndex(pos, flags) {
  flags.paths.push(...pos);
  let selected;
  if (flags.name) {
    if (flags.scope)
      throw new Error("Use --name with folders, or --index to rebuild a profile");
    const item = { name: flags.name, paths: canonicalPaths(flags.paths), ...flags.opts };
    if (profiles().some((p) => p.name === item.name) && !flags.replace)
      throw new Error(`Index already exists: ${item.name}; use --replace`);
    if (SCOPES.includes(item.name))
      throw new Error(`Reserved index name: ${item.name}`);
    selected = { scope: item.name, opts: { ...item, includeHidden: item.includeHidden ?? true, includeIgnored: item.includeIgnored ?? false } };
    await rebuildIndex(selected.scope, selected.opts);
    saveProfile(item, flags.replace);
  } else {
    selected = selection(flags);
    await rebuildIndex(selected.scope, selected.opts);
  }
  if (fs15.statSync(indexPathFor(selected.scope)).size <= 32 * 1024 * 1024)
    await prepareSearch(selected.scope, 10);
  const status = indexStatus().find((s) => s.name === selected.scope) || { name: selected.scope, paths: scopePaths(selected.scope, selected.opts), bytes: fs15.statSync(indexPathFor(selected.scope)).size };
  console.log(flags.json ? JSON.stringify(status) : `${selected.scope}: ${humanBytes(status.bytes)} \xB7 ${status.paths.join(", ")}`);
}
function cmdPreview(p, json) {
  if (!p)
    throw new Error("Specify a file or folder");
  const absolute = path14.resolve(p.replace(/^~(?=\/|$)/, HOME));
  const stat = fs15.statSync(absolute);
  let text = null;
  if (stat.isFile() && stat.size > 0) {
    const fd = fs15.openSync(absolute, "r");
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, 4000));
      const length = fs15.readSync(fd, buffer, 0, buffer.length, 0);
      if (!buffer.subarray(0, length).includes(0))
        text = buffer.subarray(0, length).toString("utf8");
    } finally {
      fs15.closeSync(fd);
    }
  }
  const meta = { path: absolute, directory: stat.isDirectory(), bytes: stat.size, modifiedAt: stat.mtime.toISOString(), text };
  console.log(json ? JSON.stringify(meta) : `${path14.basename(absolute)}
${absolute}
${stat.isDirectory() ? "folder" : humanBytes(stat.size)} \xB7 modified ${stat.mtime.toISOString()}${text === null ? "" : `

${text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")}`}`);
}
async function cmdTui(flags) {
  const { scope, opts } = selection(flags);
  await ensureIndex(scope, opts);
  const self = process.argv[1]?.endsWith(".ts") ? [process.execPath, path14.resolve(process.argv[1])] : [process.execPath];
  const selector = flags.paths.length ? flags.paths.flatMap((p) => ["--path", p]) : ["--index", scope];
  const options = [...selector, ...opts.includeHidden === false ? ["--no-hidden"] : ["--hidden"], ...opts.includeIgnored ? ["--include-ignored"] : ["--respect-ignore"], ...opts.extraExcludes ? ["--exclude", opts.extraExcludes] : [], "--max-age", opts.indexMaxAgeMinutes || "60"];
  const prefix = shellCommand(self);
  const search = shellCommand([...self, "search", "--tui", "-n", String(flags.limit), ...options]);
  const rebuild = shellCommand([...self, "index", ...options]);
  const args = [
    "--ansi",
    "--disabled",
    "--delimiter=\t",
    "--with-nth=2..",
    "--layout=reverse",
    "--scheme=path",
    `--bind=change:reload:${search} -- {q} || true`,
    `--bind=enter:execute-silent(${prefix} open {1})+abort`,
    `--bind=ctrl-r:execute-silent(${rebuild})+reload:${search} -- {q}`,
    `--bind=ctrl-o:execute-silent(${prefix} reveal {1})`,
    `--preview=${prefix} preview {1}`,
    "--preview-window=right,55%,wrap",
    `--header=Find Everything \xB7 ${scope} \xB7 Enter opens \xB7 ^R rebuild \xB7 ^O reveal`
  ];
  const child = spawn6(FZF, args, { stdio: "inherit" });
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => code === 0 || code === 130 ? resolve() : reject(new Error(`fzf exited ${code}`)));
  });
}
async function watchIndex(flags) {
  const { scope, opts } = selection(flags);
  await ensureIndex(scope, opts, false, false, true);
  stopLive = await startLive([scope], flags.interval * 1000);
}
async function main() {
  const { pos, flags } = parseFlags(process.argv.slice(2));
  if (flags.version)
    return void console.log(`fe ${VERSION2}`);
  const [cmd, ...rest] = pos;
  if (flags.help || cmd === "help")
    return void console.log(HELP);
  switch (cmd) {
    case "_search-worker":
      return serveSearchWorker();
    case "favorites":
    case "favorite": {
      const result = changeFavorites(rest[0] || "list", rest.slice(1));
      console.log(flags.json ? JSON.stringify(result) : result.paths.join(`
`));
      return;
    }
    case "semantic": {
      if (rest[0] === "status")
        return void console.log(JSON.stringify(semanticStatus()));
      if (rest[0] === "setup") {
        const child = setupProcess = track(spawn6("bash", [path14.join(runtimeDir(), "setup.sh")], { detached: process.platform !== "win32", stdio: "inherit" }));
        const timer = setTimeout(stopSetup, 180000);
        const code = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        clearTimeout(timer);
        setupProcess = undefined;
        if (code !== 0)
          throw new Error("Local sound setup failed; retry fe semantic setup");
        return;
      }
      if (rest[0] !== "index")
        throw new Error("Usage: fe semantic setup|status|index");
      const { scope, opts } = selection(flags);
      await ensureIndex(scope, opts, flags.fresh, false, true);
      const result = await indexSounds(scope, flags.query, flags.maxFiles, flags.seconds);
      console.log(JSON.stringify(result));
      return;
    }
    case "search":
      return cmdSearch(rest.join(" "), flags);
    case "combine": {
      if (!flags.name)
        throw new Error("Use fe combine --name everything");
      console.log(JSON.stringify(await combineIndexes(flags.name, flags.sources, flags.replace, flags.seconds)));
      return;
    }
    case "prepare":
    case "properties": {
      const { scope } = selection(flags);
      if (!fs15.existsSync(indexPathFor(scope)))
        throw new Error("No existing path snapshot; run fe index explicitly first");
      const result = cmd === "prepare" ? await prepareSearch(scope, flags.seconds, flags.rows) : await indexProperties(scope, flags.maxFiles, flags.seconds);
      console.log(JSON.stringify(result));
      return;
    }
    case "repair-media":
    case "enrich": {
      const { scope, opts } = selection(flags);
      await ensureIndex(scope, opts, flags.fresh, false, true);
      const result = cmd === "repair-media" ? await repairMedia(scope, flags.maxFiles, flags.seconds) : await enrichMedia(scope, flags.maxFiles, flags.seconds, flags.kind);
      console.log(flags.json ? JSON.stringify(result) : `${scope}: ${"probed" in result ? result.probed : result.inspected} inspected \xB7 ${result.reused} reused \xB7 ${result.failed} failed \xB7 ${result.pending} pending`);
      return;
    }
    case "query-help":
      return void console.log(flags.json ? JSON.stringify(QUERY_HELP) : QUERY_HELP.examples.join(`
`) + `

` + QUERY_HELP.notes);
    case "index":
      return cmdIndex(rest, flags);
    case "watch":
      return watchIndex(flags);
    case "indexes": {
      if (rest[0] === "remove") {
        if (!rest[1])
          throw new Error("Specify the index to remove");
        removeProfile(rest[1]);
        return;
      }
      if (rest.length)
        throw new Error("Usage: fe indexes [remove NAME]");
      const indexes = indexStatus();
      console.log(flags.json ? JSON.stringify(indexes) : indexes.map((i) => flags.names ? i.name : `${i.name.padEnd(16)} ${i.exists ? `${humanBytes(i.bytes)}${i.stale ? " \xB7 stale" : ""}` : "not indexed"}  ${i.paths.join(", ")}`).join(`
`));
      return;
    }
    case "status": {
      const status = { version: VERSION2, tools: { fd: FD, rg: RG, fzf: FZF, open: OPEN_CMD }, indexDir: INDEX_DIR, indexes: indexStatus().map((i) => ({ ...i, search: i.exists ? searchIndexStatus(i.name) : null })) };
      console.log(flags.json ? JSON.stringify(status) : `${Object.entries(status.tools).map(([n, p]) => `${n.padEnd(6)} ${p}`).join(`
`)}

${status.indexes.map((i) => `${i.name.padEnd(16)} ${humanBytes(i.bytes)} \xB7 ${i.stale ? "stale / missing" : "current"} \xB7 ${i.indexedAt || "never"}`).join(`
`)}`);
      return;
    }
    case "preview":
      return cmdPreview(rest[0], flags.json);
    case "open":
    case "reveal": {
      if (!rest[0] || !fs15.existsSync(rest[0]))
        throw new Error("Specify an existing path");
      if (cmd === "open")
        return openPath(rest[0]);
      const child = spawn6(OPEN_CMD, IS_MAC ? ["-R", rest[0]] : [path14.dirname(rest[0])], { stdio: "ignore", detached: true });
      child.on("error", (e) => {
        console.error(e.message);
        process.exitCode = 1;
      });
      child.unref();
      return;
    }
    case "completions":
      return void process.stdout.write(completions(rest[0]));
    case "serve":
      return serveApi(flags.port, flags.socket, flags.idleSeconds, flags.parentBound, flags.live);
    case "mcp":
      return serveMcp();
    case undefined:
    case "pick":
      return cmdTui(flags);
    default:
      return cmdSearch(pos.join(" "), flags);
  }
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    stopLive?.();
    stopSetup();
    closeSoundWorker();
    stopChildren();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
process.stdout.on("error", (e) => {
  if (e.code === "EPIPE") {
    stopChildren();
    process.exit(0);
  } else {
    console.error(e.message);
    process.exit(1);
  }
});
main().catch((e) => {
  stopChildren();
  console.error(`fe: ${e.message || e}`);
  process.exitCode = 1;
});
