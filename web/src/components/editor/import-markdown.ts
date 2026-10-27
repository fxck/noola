import { $createTextNode, $getRoot, $nodesOfType, type LexicalNode } from "lexical";
import { $convertFromMarkdownString } from "@lexical/markdown";
import { $createLinkNode, LinkNode } from "@lexical/link";
import { MD_TRANSFORMERS } from "./config";
import { URL_PLACEHOLDER_RE, extractUrls, normalizeBlockquotes } from "../../lib/markdown";

/** Fills the editor from markdown. With `linkify`, bare URLs become links without passing through the markdown importer. */
export function $importMarkdown(markdown: string, linkify = false): void {
  if (!linkify) {
    $convertFromMarkdownString(normalizeBlockquotes(markdown), MD_TRANSFORMERS);
    return;
  }
  const { text, urls } = extractUrls(markdown);
  $convertFromMarkdownString(normalizeBlockquotes(text), MD_TRANSFORMERS);
  if (urls.length) $linkUrlPlaceholders(urls);
}

/** Replaces each URL placeholder that `extractUrls` left with a link, keeping the text's formatting around it. */
function $linkUrlPlaceholders(urls: string[]): void {
  // A markdown link that `extractUrls` didn't recognise can hold a placeholder in its href.
  for (const link of $nodesOfType(LinkNode)) {
    const href = link.getURL();
    if (href.includes("\uE000")) link.setURL(href.replace(URL_PLACEHOLDER_RE, (m, i: string) => urls[Number(i)] ?? m));
  }
  for (const node of $getRoot().getAllTextNodes()) {
    const text = node.getTextContent();
    if (!text.includes("")) continue;
    const format = node.getFormat();
    const pieces: LexicalNode[] = [];
    let last = 0;
    for (const m of text.matchAll(URL_PLACEHOLDER_RE)) {
      const url = urls[Number(m[1])];
      if (!url) continue;
      if (m.index > last) pieces.push($createTextNode(text.slice(last, m.index)).setFormat(format));
      pieces.push($createLinkNode(url).append($createTextNode(url).setFormat(format)));
      last = m.index + m[0].length;
    }
    if (!pieces.length) continue;
    if (last < text.length) pieces.push($createTextNode(text.slice(last)).setFormat(format));
    let anchor: LexicalNode = node;
    for (const piece of pieces) {
      anchor.insertAfter(piece);
      anchor = piece;
    }
    node.remove();
  }
}
