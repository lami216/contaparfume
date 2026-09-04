import { randomBytes, scryptSync } from "node:crypto";
import { stdin, stdout } from "node:process";

if (stdin.isTTY) stdout.write("Password: ");
let password = "";
for await (const chunk of stdin) password += chunk;
password = password.trimEnd();
if (!password) throw new Error("Password is required on stdin");
const salt = randomBytes(24).toString("hex");
stdout.write(`${salt}:${scryptSync(password, salt, 64).toString("hex")}\n`);
