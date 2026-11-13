import { StringDecoder } from "node:string_decoder";

/** Keep UTF-8 characters intact when HTTP chunks end inside a code point. */
export async function readJsonBody(
  chunks: AsyncIterable<Uint8Array>,
  maxLength = 2e6,
): Promise<any> {
  const decoder = new StringDecoder("utf8");
  let text = "";
  for await (const chunk of chunks) {
    text += decoder.write(Buffer.from(chunk));
    if (text.length > maxLength) throw Error("请求过大");
  }
  text += decoder.end();
  if (text.length > maxLength) throw Error("请求过大");
  return JSON.parse(text || "{}");
}
