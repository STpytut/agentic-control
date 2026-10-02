// What may reach `claude auth login` on its stdin (rc.123): the code the owner
// pasted, once, as one line. The account surface runs the login and nothing
// else; this keeps it from becoming a way to type into Claude Code.

const CODE = /^[A-Za-z0-9_#.~-]{8,512}\n$/;

export function claudeAccountState() {
  return { codeSent: false };
}

export function validateClaudeAccountInput(data, state) {
  if (state?.codeSent) throw new Error("Claude Code's sign-in takes one code");
  if (!CODE.test(String(data))) throw new Error("Claude Code's sign-in accepts only the code, on one line");
  state.codeSent = true;
}
