// A deterministic tar.gz writer, and the safe reader the verifier uses.
//
// `tar` and `gzip` are perfectly capable of writing this archive, and using them
// would mean depending on whichever versions the build host happens to have. The
// property this stage needs is not "an archive is produced" but "the same input
// produces the same bytes on every host", and that property is easier to
// guarantee — and to test — when the writer is ours. The format is small enough
// that writing it is not the hard part; getting the normalisation right is, and
// that is the part this module concentrates on.
//
// Normalised, so two builds of the same commit agree byte for byte:
//
//   * member order — lexicographic, after directory entries that must come first;
//   * uid/gid — 0:0, with empty uname/gname, so the build account cannot leak;
//   * modes — 0644 for files, 0755 for directories and executables;
//   * mtime — SOURCE_DATE_EPOCH, from the commit, never `Date.now()`;
//   * format — POSIX ustar with a `root/` prefix on every name, which avoids the
//     pax extension entirely and keeps a member name from ever being a path.
//
// The reader is separate and deliberately conservative. It refuses absolute
// members, `..` escapes, hard links, devices, FIFOs and sockets, and it resolves
// nothing before deciding: an archive is untrusted input, and "extract then
// inspect" is how a tarball writes outside the directory it was extracted into.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, lstatSync, readlinkSync, symlinkSync, writeFileSync, chmodSync, realpathSync } from "node:fs";
import path from "node:path";

export class ArchiveError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArchiveError";
  }
}

const BLOCK = 512;
// 8 GiB: far above anything this release contains, and small enough that the
// field is provably eight octal digits, which keeps the header free of the GNU
// base-256 extension.
const MAX_MEMBER_BYTES = 0o77777777777;

const MODE_DIRECTORY = 0o755;
const MODE_EXECUTABLE = 0o755;
const MODE_FILE = 0o644;

// ---------------------------------------------------------------------------
// Deterministic tar
// ---------------------------------------------------------------------------

// A tar header field, NUL-terminated. `value` must already fit.
function writeString(block, offset, length, value) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) {
    throw new ArchiveError(`tar field at ${offset} is ${length} bytes, value ${JSON.stringify(value)} does not fit`);
  }
  bytes.copy(block, offset);
}

function writeOctal(block, offset, length, value) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_MEMBER_BYTES) {
    throw new ArchiveError(`tar numeric field at ${offset} cannot hold ${value}`);
  }
  // `length - 1` digits plus a NUL. Every value used here fits in seven octal
  // digits, so the leading digit is always 0 and the field is unambiguous.
  const text = value.toString(8).padStart(length - 1, "0");
  writeString(block, offset, length, `${text}\0`);
}

function header({ name, size, mode, mtime, typeflag, linkname = "" }) {
  const block = Buffer.alloc(BLOCK);
  writeString(block, 0, 100, name);
  writeOctal(block, 100, 8, mode);
  writeOctal(block, 108, 8, 0); // uid
  writeOctal(block, 116, 8, 0); // gid
  writeOctal(block, 124, 12, size);
  writeOctal(block, 136, 12, mtime);

  // The checksum is computed over the header with the checksum field read as
  // spaces, which is what makes the result a fixed point.
  block.fill(0x20, 148, 156);
  block.writeUInt8(typeflag.charCodeAt(0), 156);
  writeString(block, 257, 6, "ustar\0"); // POSIX ustar magic
  writeString(block, 263, 2, "00"); // POSIX version
  // The 100-byte link target lives at 157, immediately after the typeflag, and it
  // is what a symlink member carries. Writing it at the wrong offset produces an
  // archive that this module's own reader still parses — a reader that looks in
  // both places — while `tar` silently treats every symlink as a regular file
  // whose name begins with the target. That is exactly the defect this line had,
  // and it survived four round-trip tests because the tests used this reader.
  writeString(block, 157, 100, linkname);
  // 265 uname and 297 gname stay NUL: an empty owner records 0:0 without naming
  // the account that ran the build. 265 + 32 = 297, and 297 + 32 = 329, which is
  // where the 8-byte devmajor field begins.

  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) sum += block[index];
  writeString(block, 148, 7, sum.toString(8).padStart(6, "0"));
  block.writeUInt8(0, 155);
  return block;
}

function padding(size) {
  const remainder = size % BLOCK;
  return remainder === 0 ? 0 : BLOCK - remainder;
}

// The pax extended header, used only when a member name or link target does not
// fit the 100 bytes ustar reserves for it.
//
// This is not an optimisation; it is required. A pnpm store key is derived from the
// package name, its version and every peer dependency it resolved, so
// `next@16.2.10_@babel+core@..._react-dom@..._react@...` runs well past 100 bytes
// before the path inside the package is even added. The alternatives to pax are a
// GNU long-name header — a non-standard extension — or refusing the pnpm layout,
// which would mean flattening the dependency tree and giving up on the property
// that makes the tree relocatable.
//
// pax is deterministic: the header name is synthesised from the member, the
// records are ASCII in a fixed order, and the mtime is the same SOURCE_DATE_EPOCH
// as every other header. Nothing about it depends on the build host.
function paxRecord(key, value) {
  // "<length> <key>=<value>\n". The length includes its own decimal digits, which
  // is why the digit count is computed in a loop: adding a digit can push the
  // number into the next order of magnitude. Getting this wrong produces a header
  // that some readers accept and others desynchronise on.
  const body = ` ${key}=${value}\n`;
  const bodyBytes = Buffer.byteLength(body, "utf8");
  let digits = 1;
  while (String(bodyBytes + digits).length > digits) digits += 1;
  return Buffer.from(`${bodyBytes + digits}${body}`, "utf8");
}

// A name that fits the ustar field. pax carries the real path; this is the
// fallback for a reader that ignores the extension, so it keeps as many trailing
// components as fit and never exceeds the field.
function ustarNameFallback(name) {
  const bytes = Buffer.byteLength(name, "utf8");
  if (bytes <= 100) return name;
  const segments = name.split("/");
  const kept = [];
  let length = 0;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const addition = (kept.length === 0 ? 0 : 1) + Buffer.byteLength(segments[index], "utf8");
    if (length + addition > 100) break;
    kept.unshift(segments[index]);
    length += addition;
  }
  if (kept.length === 0) {
    throw new ArchiveError(
      `the last path component of ${name} is longer than 100 bytes and cannot be represented in a tar member name`,
    );
  }
  return kept.join("/");
}

function paxHeaderFor(member, mtime) {
  if (Buffer.byteLength(member.name, "utf8") <= 100) return null;
  if (member.mtime !== mtime) throw new ArchiveError("internal: pax mtime must be SOURCE_DATE_EPOCH");
  // Only the member *path* is carried in an extended header. Link targets are not:
  // pax has a `linkpath` record for them, but libarchive 3.7 places such a symlink
  // at a path derived from the following entry rather than the record, so an
  // archive that relies on it extracts differently under the two tar
  // implementations that matter. `release-assemble.mjs` materialises any link whose
  // target does not fit the ustar field, and `writeTar` refuses one here so the
  // invariant cannot be lost silently.
  const data = paxRecord("path", member.name);
  return {
    block: header({
      name: `PaxHeaders/${member.name.split("/")[0]}`,
      size: data.length,
      mode: 0o644,
      mtime,
      typeflag: "x",
    }),
    data,
  };
}

// Collects every member of `directory` as a tar entry, with the deterministic
// ordering the writer documents: directories first (shallowest first, so a
// directory entry always precedes its contents), then everything else by path.
export function collectMembers(directory, { prefix, sourceDateEpoch }) {
  const root = realpathSync(directory);
  const directories = [];
  const others = [];

  const walk = (current, relative) => {
    for (const name of readdirSync(current)) {
      const absolute = path.join(current, name);
      const entryPath = relative ? `${relative}/${name}` : name;
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) {
        others.push({ type: "symlink", path: entryPath, linkname: readlinkSync(absolute) });
        continue;
      }
      if (info.isDirectory()) {
        directories.push({ type: "directory", path: entryPath });
        walk(absolute, entryPath);
        continue;
      }
      if (!info.isFile()) {
        throw new ArchiveError(`${entryPath} is not a regular file, a directory or a symlink`);
      }
      others.push({
        type: "file",
        path: entryPath,
        size: info.size,
        absolute,
        // A file that anyone can execute, or that the owner may execute, keeps the
        // executable bit. Anything else is 0644. This is the only place a mode
        // from the filesystem influences the archive, and it is a binary decision
        // so that an umask cannot change the output.
        mode: (info.mode & 0o100) !== 0 ? MODE_EXECUTABLE : MODE_FILE,
      });
    }
  };
  walk(root, "");

  directories.sort((left, right) => {
    const depth = left.path.split("/").length - right.path.split("/").length;
    if (depth !== 0) return depth;
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  });
  // A file can never be the parent of a directory, so sorting the rest by path
  // alone already puts every directory before its own children.
  others.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

  const rootPrefix = `${prefix}/`;
  const mtime = sourceDateEpoch;
  const members = [
    { type: "directory", path: "", mode: MODE_DIRECTORY, mtime, name: rootPrefix },
  ];
  for (const entry of directories) {
    members.push({ ...entry, mode: MODE_DIRECTORY, mtime, name: rootPrefix + entry.path });
  }
  for (const entry of others) {
    members.push({ ...entry, mtime, name: rootPrefix + entry.path });
  }

  // A name is permitted to exceed the ustar field; `paxHeaderFor` carries it. What
  // is refused is a name whose final component cannot fit, because no encoding
  // makes that representable.
  for (const member of members) {
    if (Buffer.byteLength(member.name, "utf8") > 4096) {
      throw new ArchiveError(`tar member name is unreasonably long (${Buffer.byteLength(member.name, "utf8")} bytes): ${member.name}`);
    }
    ustarNameFallback(member.name);
    if (member.linkname !== undefined) {
      const linkBytes = Buffer.byteLength(member.linkname, "utf8");
      if (linkBytes > 100) {
        throw new ArchiveError(
          `tar symlink ${member.name} has a ${linkBytes}-byte target, which the ustar field cannot hold. `
            + "The release assembler materialises such a link instead of writing it; seeing one here means that step was skipped.",
        );
      }
    }
  }
  return members;
}

// Writes the tar stream. `write` is called with each block, so a caller can feed
// it straight into gzip or collect it in memory for a diff.
export function writeTar(directory, { prefix, sourceDateEpoch, write }) {
  if (!Number.isInteger(sourceDateEpoch) || sourceDateEpoch < 0) {
    throw new ArchiveError(`SOURCE_DATE_EPOCH must be a non-negative integer, got ${JSON.stringify(sourceDateEpoch)}`);
  }
  const members = collectMembers(directory, { prefix, sourceDateEpoch });
  for (const member of members) {
    // A pax record precedes the entry it describes and uses the same mtime, so the
    // archive stays a function of its input only.
    const pax = paxHeaderFor(member, sourceDateEpoch);
    if (pax) {
      write(pax.block);
      write(pax.data);
      const pad = padding(pax.data.length);
      if (pad > 0) write(Buffer.alloc(pad));
    }
    const name = ustarNameFallback(member.name);
    if (member.type === "file") {
      write(header({
        name,
        size: member.size,
        mode: member.mode,
        mtime: member.mtime,
        typeflag: "0",
      }));
      write(readFileSync(member.absolute));
      const pad = padding(member.size);
      if (pad > 0) write(Buffer.alloc(pad));
      continue;
    }
    if (member.type === "directory") {
      write(header({
        name,
        size: 0,
        mode: member.mode,
        mtime: member.mtime,
        typeflag: "5",
      }));
      continue;
    }
    write(header({
      name,
      size: 0,
      mode: MODE_EXECUTABLE,
      mtime: member.mtime,
      typeflag: "2",
      linkname: member.linkname,
    }));
  }
  // The end-of-archive marker is exactly two zero blocks. A tar stream may be
  // padded to a 10240-byte record boundary afterwards, but that padding is not part
  // of the marker: an archiver that sees 20 zero blocks instead of 2 is entitled to
  // complain, and `tar` on Ubuntu does. What terminates the archive is the pair.
  write(Buffer.alloc(BLOCK * 2));
  return members;
}

// ---------------------------------------------------------------------------
// Safe reading
// ---------------------------------------------------------------------------

const TYPE_FILE = "0";
const TYPE_FILE_LEGACY = "\0";
const TYPE_HARDLINK = "1";
const TYPE_SYMLINK = "2";
const TYPE_CHAR = "3";
const TYPE_BLOCK = "4";
const TYPE_DIRECTORY = "5";
const TYPE_FIFO = "6";
const TYPE_CONTIGUOUS = "7";
const TYPE_PAX = "x";
const TYPE_PAX_GLOBAL = "g";

const SUPPORTED_TYPES = new Set([TYPE_FILE, TYPE_FILE_LEGACY, TYPE_SYMLINK, TYPE_DIRECTORY, TYPE_CONTIGUOUS]);

function parseOctal(block, offset, length) {
  const text = block.subarray(offset, offset + length).toString("latin1").replace(/\0.*$/, "").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) {
    // A leading 0x80 means the GNU base-256 extension, which this writer never
    // produces; refusing means a hand-crafted archive cannot smuggle in a size the
    // reader would misinterpret.
    throw new ArchiveError(`tar field at ${offset} is not plain octal: ${JSON.stringify(text)}`);
  }
  return Number.parseInt(text, 8);
}

function readString(block, offset, length) {
  const end = block.indexOf(0, offset);
  const slice = block.subarray(offset, end === -1 || end > offset + length ? offset + length : end);
  return slice.toString("utf8");
}

// Reads a tar buffer into members. `withData` decides whether file bytes are
// sliced out — `listTarMembers` deliberately does not, so that listing an archive
// is cheap and cannot be confused with reading it.
function readEntries(buffer, { withData }) {
  if (!Buffer.isBuffer(buffer)) throw new ArchiveError("archive input is not a Buffer");
  const members = [];
  let offset = 0;
  let zeroBlocks = 0;
  let terminated = false;
  let pendingPax = {};

  while (offset + BLOCK <= buffer.length) {
    const block = buffer.subarray(offset, offset + BLOCK);
    offset += BLOCK;
    if (block.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      if (zeroBlocks === 2) { terminated = true; break; }
      continue;
    }
    zeroBlocks = 0;

    const name = readString(block, 0, 100);
    const mode = parseOctal(block, 100, 8);
    const size = parseOctal(block, 124, 12);
    const mtime = parseOctal(block, 136, 12);
    const type = String.fromCharCode(block[156]);
    const linkname = readString(block, 157, 100);
    const magic = readString(block, 257, 6);
    if (magic !== "ustar") {
      throw new ArchiveError(`tar member ${JSON.stringify(name)} does not use the ustar format (magic ${JSON.stringify(magic)})`);
    }

    // The header checksum is verified before any field in the header is believed:
    // a corrupt name could otherwise be the thing a path check runs against.
    const declared = parseOctal(block, 148, 8);
    let sum = 0;
    for (let index = 0; index < BLOCK; index += 1) {
      sum += index >= 148 && index < 156 ? 0x20 : block[index];
    }
    if (sum !== declared) {
      throw new ArchiveError(`tar member ${JSON.stringify(name)} has a bad header checksum (${declared} declared, ${sum} computed)`);
    }

    const member = { name, mode, size, mtime, type, linkname };

    // A pax header is consumed, not emitted as a member: its records replace the
    // fields of the entry that follows. `path` and `linkpath` are the only
    // attributes this writer produces; a record it does not understand is an error
    // rather than something to ignore, because silently ignoring `size` would
    // desynchronise the stream.
    if (type === TYPE_PAX || type === TYPE_PAX_GLOBAL) {
      if (offset + size > buffer.length) {
        throw new ArchiveError(`pax header ${JSON.stringify(name)} claims ${size} bytes but the archive ends first`);
      }
      const records = buffer.subarray(offset, offset + size).toString("utf8");
      offset += size + padding(size);
      pendingPax = { ...pendingPax, ...parsePaxRecords(records, name) };
      continue;
    }

    if (size !== 0 && (type === TYPE_DIRECTORY || type === TYPE_SYMLINK)) {
      throw new ArchiveError(`tar member ${JSON.stringify(name)} is type ${JSON.stringify(type)} but declares ${size} bytes`);
    }

    if (pendingPax.path !== undefined) {
      member.name = pendingPax.path;
    }
    if (pendingPax.linkpath !== undefined && type === TYPE_SYMLINK) {
      member.linkname = pendingPax.linkpath;
    }
    pendingPax = {};

    if (type === TYPE_FILE || type === TYPE_FILE_LEGACY || type === TYPE_CONTIGUOUS) {
      if (offset + size > buffer.length) {
        throw new ArchiveError(`tar member ${JSON.stringify(name)} claims ${size} bytes but the archive ends first`);
      }
      if (withData) member.data = buffer.subarray(offset, offset + size);
      offset += size + padding(size);
    }
    members.push(member);
  }

  if (!terminated) throw new ArchiveError("tar archive has no end-of-archive marker; it is truncated");
  return members;
}

// Parses the `<length> <key>=<value>\\n` records of a pax header. The length is the
// total record length including its own digits, which is why it is parsed in two
// steps rather than by splitting on newlines.
function parsePaxRecords(text, headerName) {
  const records = {};
  let offset = 0;
  while (offset < text.length) {
    const space = text.indexOf(" ", offset);
    if (space === -1) throw new ArchiveError(`pax header ${JSON.stringify(headerName)} has a malformed record`);
    const declared = Number(text.slice(offset, space));
    if (!Number.isInteger(declared) || declared <= 0 || offset + declared > text.length) {
      throw new ArchiveError(`pax header ${JSON.stringify(headerName)} has a record length of ${text.slice(offset, space)}`);
    }
    const record = text.slice(space + 1, offset + declared);
    offset += declared;
    const equals = record.indexOf("=");
    if (equals === -1) throw new ArchiveError(`pax header ${JSON.stringify(headerName)} has a record without "="`);
    const key = record.slice(0, equals);
    const value = record.slice(equals + 1).replace(/\n$/, "");
    if (key === "path" || key === "linkpath") records[key] = value;
    else if (key === "size" || key === "mtime" || key === "uid" || key === "gid" || key === "uname" || key === "gname") continue;
    else throw new ArchiveError(`pax header ${JSON.stringify(headerName)} carries an unsupported attribute ${JSON.stringify(key)}`);
  }
  return records;
}

export function listTarMembers(buffer) {
  return readEntries(buffer, { withData: false }).map(({ data, ...member }) => member);
}

export function readTarMembers(buffer) {
  return readEntries(buffer, { withData: true });
}

// Refuses any member that could write outside the extraction root, and returns
// the single top-level directory the archive claims.
//
// Every refusal names the member it refused: a test that fails with "unsafe
// archive" and no path is a test somebody will weaken to make it pass.
export function assertSafeMembers(members) {
  if (members.length === 0) throw new ArchiveError("tar archive is empty");

  const roots = new Set();
  for (const member of members) {
    if (member.name.startsWith("/") || /^[A-Za-z]:/.test(member.name)) {
      throw new ArchiveError(`tar member ${JSON.stringify(member.name)} is an absolute path`);
    }
    const parts = member.name.replace(/\/+$/, "").split("/");
    if (parts.some((part) => part === ".." || part === "." || part === "")) {
      throw new ArchiveError(`tar member ${JSON.stringify(member.name)} is not a normalised relative path`);
    }
    roots.add(parts[0]);

    if (member.type === TYPE_HARDLINK) {
      throw new ArchiveError(`tar member ${JSON.stringify(member.name)} is a hard link, which this archive never contains`);
    }
    if (member.type === TYPE_CHAR) {
      throw new ArchiveError(`tar member ${JSON.stringify(member.name)} is a character device`);
    }
    if (member.type === TYPE_BLOCK) {
      throw new ArchiveError(`tar member ${JSON.stringify(member.name)} is a block device`);
    }
    if (member.type === TYPE_FIFO) {
      throw new ArchiveError(`tar member ${JSON.stringify(member.name)} is a FIFO`);
    }
    if (!SUPPORTED_TYPES.has(member.type)) {
      throw new ArchiveError(`tar member ${JSON.stringify(member.name)} has unsupported type ${JSON.stringify(member.type)}`);
    }
    if (member.type === TYPE_SYMLINK) {
      if (member.linkname.startsWith("/") || path.isAbsolute(member.linkname)) {
        throw new ArchiveError(`tar symlink ${JSON.stringify(member.name)} has an absolute target ${JSON.stringify(member.linkname)}`);
      }
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(member.name), member.linkname));
      if (resolved === ".." || resolved.startsWith("../")) {
        throw new ArchiveError(
          `tar symlink ${JSON.stringify(member.name)} escapes the archive with target ${JSON.stringify(member.linkname)}`,
        );
      }
    }
  }

  if (roots.size !== 1) {
    throw new ArchiveError(`tar archive must contain exactly one top-level directory, found ${roots.size}: ${[...roots].join(", ")}`);
  }
  return [...roots][0];
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// Extracts a tar buffer into `destination`, which is created if necessary.
//
// Extraction re-checks every resolved path against the destination rather than
// trusting `assertSafeMembers` to have been called: the name check and the write
// are the two places an escape can happen, and a guarantee that lives in only one
// of them is a guarantee a refactor removes from the other.
//
// Symlinks are created last, after every file and directory, so a link can never
// be the thing a later member is written through.
export function extractTar(buffer, destination, { topLevelDirectory } = {}) {
  const members = readTarMembers(buffer);
  const root = assertSafeMembers(members);
  if (topLevelDirectory !== undefined && root !== topLevelDirectory) {
    throw new ArchiveError(
      `tar archive top-level directory is ${JSON.stringify(root)}, expected ${JSON.stringify(topLevelDirectory)}`,
    );
  }

  const target = path.resolve(destination);
  mkdirSync(target, { recursive: true });
  const symlinks = [];

  for (const member of members) {
    const resolved = path.resolve(target, member.name);
    if (!isInside(target, resolved)) {
      throw new ArchiveError(`tar member ${JSON.stringify(member.name)} would be written outside the extraction root`);
    }
    if (member.type === TYPE_DIRECTORY) {
      mkdirSync(resolved, { recursive: true });
      chmodSync(resolved, MODE_DIRECTORY);
      continue;
    }
    if (member.type === TYPE_SYMLINK) {
      symlinks.push({ resolved, linkname: member.linkname, name: member.name });
      continue;
    }
    mkdirSync(path.dirname(resolved), { recursive: true });
    const existing = lstatSync(resolved, { throwIfNoEntry: false });
    if (existing?.isSymbolicLink()) {
      throw new ArchiveError(`tar member ${JSON.stringify(member.name)} would be written through a symlink`);
    }
    writeFileSync(resolved, member.data, { mode: member.mode & 0o777 || MODE_FILE });
  }

  for (const link of symlinks) {
    const parent = path.dirname(link.resolved);
    const resolvedTarget = path.resolve(parent, link.linkname);
    if (!isInside(target, resolvedTarget)) {
      throw new ArchiveError(`tar symlink ${JSON.stringify(link.name)} would be created outside the extraction root`);
    }
    mkdirSync(parent, { recursive: true });
    if (lstatSync(link.resolved, { throwIfNoEntry: false })) {
      throw new ArchiveError(`tar symlink ${JSON.stringify(link.name)} collides with an existing entry`);
    }
    symlinkSync(link.linkname, link.resolved);
  }

  return { root, members: members.length };
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
