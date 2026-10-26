import { ChannelType, type Client } from "discord.js";
import { buildMirrorTransport, type MirrorFile } from "../src/discord-gateway.js";

// The mirror transport against a fake discord.js client. Discord refuses an upload over the server's
// limit with code 40005 (HTTP 413) and creates nothing, which the fake mirrors for files over LIMIT.

let failures = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${got !== undefined ? ` — got: ${JSON.stringify(got)}` : ""}`); }
}

const LIMIT = 100;
type Sent = { content?: string; files?: { attachment: Buffer; name: string }[]; nonce?: string };
const tooLarge = () => Object.assign(new Error("Request entity too large"), { code: 40005, status: 413 });
const refuses = (m: { files?: { attachment: Buffer }[] }) => (m.files ?? []).some((f) => f.attachment.length > LIMIT);

let sent: Sent[] = [];
let created: { name: string; message: Sent }[] = [];
let failWith: Error | null = null;
const fakeThread = {
  isThread: () => true,
  archived: false,
  async send(m: Sent) {
    if (failWith) throw failWith;
    if (refuses(m)) throw tooLarge();
    sent.push(m);
    return { id: `m${sent.length}` };
  },
};
const fakeForum = {
  type: ChannelType.GuildForum,
  availableTags: [],
  threads: {
    async create(o: { name: string; message: Sent }) {
      if (refuses(o.message)) throw tooLarge();
      created.push(o);
      return { id: "post-1", send: async (m: Sent) => { sent.push(m); } };
    },
  },
};
const client = { channels: { fetch: async (id: string) => (id === "forum" ? fakeForum : fakeThread) } } as unknown as Client;
const tp = buildMirrorTransport(client);

const big = (name: string): MirrorFile => ({ name, data: Buffer.alloc(LIMIT + 1) });
const small = (name: string, keep = false): MirrorFile => ({ name, data: Buffer.from("full text"), keepWhenRefused: keep });
const names = (m?: Sent) => (m?.files ?? []).map((f) => f.name);

async function main() {
  // A refused upload goes again with only the kept file, and the note counts the dropped one.
  sent = [];
  await tp.postToThread("t1", "TRANSPORT body", [big("video.mp4"), small("message.txt", true)], undefined, { nonce: "n1" });
  check("a refused upload is sent again with only the kept file", sent.length === 2 && names(sent[0]).join() === "message.txt" && sent[0].nonce === "n1.0", sent.map(names));
  check("the note counts only the dropped file", sent[1]?.content?.includes("1 attachment was too large") === true && sent[1]?.nonce === "n1.f", sent[1]?.content);

  // When the kept file is refused too, the text goes alone and the note counts both.
  sent = [];
  await tp.postToThread("t1", "TRANSPORT body", [big("video.mp4"), { ...big("message.txt"), keepWhenRefused: true }], undefined, { nonce: "n2" });
  check("a refused kept file leaves the text alone", sent.length === 2 && names(sent[0]).length === 0 && sent[0].content === "TRANSPORT body", sent.map(names));
  check("the note counts every file", sent[1]?.content?.includes("2 attachments were too large") === true, sent[1]?.content);

  // Without a kept file there is nothing to try again with.
  sent = [];
  await tp.postToThread("t1", "TRANSPORT body", [big("video.mp4")], undefined, { nonce: "n3" });
  check("a refused upload without a kept file sends the text", sent.length === 2 && names(sent[0]).length === 0, sent.map(names));

  // Any other error is the outbox's to retry.
  failWith = new Error("socket hang up");
  const rejected = await tp.postToThread("t1", "TRANSPORT body", [small("a.txt")], undefined, { nonce: "n4" }).then(() => false, () => true);
  failWith = null;
  check("an error other than a too-large upload is thrown", rejected);

  // A forum post keeps the kept file and says which files were dropped.
  sent = []; created = [];
  const post = await tp.createForumPost("forum", "TRANSPORT title", "TRANSPORT header", [], [big("video.mp4"), small("message.txt", true)]);
  check("a refused forum post is created with only the kept file", !!post && created.length === 1 && names(created[0].message).join() === "message.txt", created.map((c) => names(c.message)));
  check("and notes the dropped file", created[0]?.message.content?.includes("1 attachment was too large") === true, created[0]?.message.content);

  console.log(failures ? `\n${failures} FAILURES` : "\nDISCORD-TRANSPORT: all checks green");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
