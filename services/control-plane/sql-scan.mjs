// Shared lexical scanning for SQL text.
//
// Both users need the same thing: walk a statement and ignore anything inside a
// string literal, a quoted identifier, a line or block comment, or a
// dollar-quoted body. Every function body in db/migrations is dollar-quoted and
// full of semicolons and COMMITs, so a plain search over the text is wrong.

// Returns the source with all literals, comments and dollar-quoted bodies
// replaced by spaces, preserving offsets so positions stay meaningful.
export function stripNonCode(sql) {
  const out = new Array(sql.length).fill(" ");
  let index = 0;

  while (index < sql.length) {
    const character = sql[index];

    if (character === "'" || character === '"') {
      const quote = character;
      // In an escape string, E'...', a backslash escapes the next character, so
      // E'a\'' is one literal containing a quote. Without this the scan ends the
      // literal early and everything after it is misread — a trailing COMMIT or
      // a second statement would be missed entirely. Standard literals treat a
      // backslash as an ordinary character (standard_conforming_strings is on),
      // and both forms accept a doubled quote.
      const escapes = quote === "'" && /(^|[^A-Za-z0-9_])[Ee]$/.test(sql.slice(0, index));
      index += 1;
      while (index < sql.length) {
        if (escapes && sql[index] === "\\") { index += 2; continue; }
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) { index += 2; continue; }
          break;
        }
        index += 1;
      }
      index += 1;
      continue;
    }

    if (character === "-" && sql[index + 1] === "-") {
      const newline = sql.indexOf("\n", index);
      index = newline === -1 ? sql.length : newline;
      continue;
    }

    if (character === "/" && sql[index + 1] === "*") {
      // Block comments nest in PostgreSQL.
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql[index] === "/" && sql[index + 1] === "*") { depth += 1; index += 2; continue; }
        if (sql[index] === "*" && sql[index + 1] === "/") { depth -= 1; index += 2; continue; }
        index += 1;
      }
      continue;
    }

    if (character === "$") {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(index));
      if (tag) {
        const closing = sql.indexOf(tag[0], index + tag[0].length);
        index = closing === -1 ? sql.length : closing + tag[0].length;
        continue;
      }
    }

    out[index] = character;
    index += 1;
  }

  return out.join("");
}

// True when the SQL carries more than one statement at the top level.
export function hasMultipleStatements(sql) {
  const code = stripNonCode(sql);
  const separator = code.indexOf(";");
  if (separator === -1) return false;
  return /[^\s]/.test(code.slice(separator + 1));
}

// Every statement PostgreSQL treats as transaction control. A migration that
// runs any of these cannot be wrapped by the runner: BEGIN would nest, and
// COMMIT, END, ROLLBACK or ABORT would close the runner's transaction early,
// silently giving up the atomicity the wrapper exists to provide.
const TRANSACTION_CONTROL =
  /(?:^|;)\s*(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE\s+SAVEPOINT|PREPARE\s+TRANSACTION)\b/i;

// Names the first transaction-control statement in the SQL, or null.
export function transactionControlStatement(sql) {
  const match = TRANSACTION_CONTROL.exec(stripNonCode(sql));
  return match ? match[1].replace(/\s+/g, " ").toUpperCase() : null;
}
