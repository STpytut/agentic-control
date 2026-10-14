// What may reach Antigravity's sign-in on its stdin (rc.150): the authorization
// code the owner pasted, once, as one line. The account surface runs one
// headless prompt whose only purpose is to make agy ask for its sign-in; this
// keeps the channel from becoming a way to type into the model's run.
//
// Google's authorization codes carry slashes (`4/0A…`), which Claude's do not,
// so the pattern is this runtime's own.

const CODE = /^[A-Za-z0-9_./~-]{8,512}\n$/;

export function antigravityAccountState() {
  return { codeSent: false };
}

export function validateAntigravityAccountInput(data, state) {
  if (state?.codeSent) throw new Error("Antigravity's sign-in takes one code");
  if (!CODE.test(String(data))) throw new Error("Antigravity's sign-in accepts only the code, on one line");
  state.codeSent = true;
}

// What the account worker reads from the sign-in's output (claude-login.mjs,
// generalised in rc.150): the Google authorize link agy prints on stderr, and
// how the run ends. A run that ends well before showing a link was already
// signed in: there is nothing to paste, and the sign-in has succeeded.
export const ANTIGRAVITY_LOGIN = Object.freeze({
  label: "Antigravity",
  urlPattern: /https:\/\/accounts\.google\.com\/\S+/,
  // The headless prompt's result after the code was taken, or exit 0.
  succeeded: (output, code) => code === 0 || /"status"\s*:\s*"SUCCESS"/.test(output),
  signedInWithoutLink: true,
  // agy waits 60 s for the code once it has shown the link.
  codeWithinMs: 60_000,
});
