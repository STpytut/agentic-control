// A runtime process that cannot write the workspace, by the kernel (11.2 N4, D5).
//
// A read-only grant still hands the workspace tree to the runtime's user: the
// runtime accounts cannot read a tree they do not own (server.mjs, openChannel).
// Codex keeps its turn read-only with its own Landlock sandbox, proved on rc.30.
// OpenCode has no sandbox of its own, and a turn that is read-only because the
// prompt says so is not read-only. Decision D5: the OS, not the prompt.
//
// So the process is started under a Landlock ruleset that handles every
// filesystem right the kernel knows and grants only:
//
//   * read and execute beneath `/` — the workspace, the runtime, the libraries;
//   * every right beneath the few paths the runtime keeps its own state in.
//
// A write to the workspace — or anywhere else — is then EACCES from the kernel,
// whatever the model asks for and whatever permission the runtime's own config
// grants. Landlock needs no privilege and is inherited by every child, so a
// shell the model starts is inside it too; the supervisor keeps
// NoNewPrivileges and no CAP_SYS_ADMIN, which rules out a read-only mount.
//
// It fails closed. A kernel without Landlock, or a ruleset that cannot be
// built, ends the launch with exit 78 before the runtime starts; a turn that
// was to be read-only never runs unconfined.
//
// Python, like the fence and dpkg's lock (runtime-fence.mjs, update.mjs): it
// is on every host this product supports, reaches the three syscalls through
// ctypes, and needs nothing installed. The syscall numbers are the generic
// ones, the same on x86_64 and aarch64.

export const READ_ONLY_LAUNCH_EXIT = 78;

const SCRIPT = String.raw`
import ctypes, os, sys
libc = ctypes.CDLL(None, use_errno=True)
CREATE, ADD_RULE, RESTRICT = 444, 445, 446

def fail(message):
    sys.stderr.write("infra-cod read-only launch: " + message + "; the run is refused rather than run unconfined\n")
    sys.exit(78)

class RulesetAttr(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]

class PathBeneath(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]

abi = libc.syscall(CREATE, None, ctypes.c_size_t(0), ctypes.c_uint32(1))
if abi < 1:
    fail("this kernel offers no Landlock (errno %d)" % ctypes.get_errno())
EXECUTE, WRITE_FILE, READ_FILE, READ_DIR = 1, 2, 4, 8
REFER, TRUNCATE, IOCTL_DEV = 1 << 13, 1 << 14, 1 << 15
handled = (1 << 13) - 1
if abi >= 2: handled |= REFER
if abi >= 3: handled |= TRUNCATE
if abi >= 5: handled |= IOCTL_DEV
FILE_RIGHTS = EXECUTE | WRITE_FILE | READ_FILE | TRUNCATE | IOCTL_DEV

try:
    separator = sys.argv.index("--")
except ValueError:
    fail("no command after --")
writable, command = sys.argv[1:separator], sys.argv[separator + 1:]
if not command:
    fail("no command after --")

attr = RulesetAttr(handled)
ruleset = libc.syscall(CREATE, ctypes.byref(attr), ctypes.c_size_t(ctypes.sizeof(attr)), ctypes.c_uint32(0))
if ruleset < 0:
    fail("the ruleset could not be created (errno %d)" % ctypes.get_errno())

def allow(path, access):
    descriptor = os.open(path, os.O_PATH | os.O_CLOEXEC)
    try:
        if not os.path.isdir(path):
            access &= FILE_RIGHTS
        rule = PathBeneath(access & handled, descriptor)
        if libc.syscall(ADD_RULE, ctypes.c_int(ruleset), ctypes.c_int(1), ctypes.byref(rule), ctypes.c_uint32(0)) != 0:
            fail("%s could not be added (errno %d)" % (path, ctypes.get_errno()))
    finally:
        os.close(descriptor)

allow("/", EXECUTE | READ_FILE | READ_DIR)
for path in writable:
    if os.path.exists(path):
        allow(path, handled)
if libc.prctl(38, 1, 0, 0, 0) != 0:
    fail("no_new_privs could not be set (errno %d)" % ctypes.get_errno())
if libc.syscall(RESTRICT, ctypes.c_int(ruleset), ctypes.c_uint32(0)) != 0:
    fail("the ruleset could not be enforced (errno %d)" % ctypes.get_errno())
os.close(ruleset)
os.execvp(command[0], command)
`;

// The argv that runs `command` under the ruleset: prepended to what runuser
// executes, after `env -i`, so the ruleset is taken as the runtime's user and
// the runtime inherits it. `writable` are the runtime's own state paths; a
// path that does not exist yet is skipped, not created.
export function readOnlyLaunchArgv(writable, command, args = [], { python = "/usr/bin/python3" } = {}) {
  for (const path of writable) {
    if (typeof path !== "string" || !path.startsWith("/") || path === "/" || path.split("/").includes("..")) {
      throw new Error(`a writable path for a read-only launch must be absolute and below /: ${JSON.stringify(path)}`);
    }
  }
  return [python, "-c", SCRIPT, ...writable, "--", command, ...args];
}
