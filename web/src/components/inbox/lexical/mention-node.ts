import {
  $applyNodeReplacement,
  TextNode,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedTextNode,
  type Spread,
} from "lexical";

// A mention is a segmented TextNode that renders "@Name" as one atomic, styled chip
// and carries the resolved member id. The id is what we send to the server, so a note
// loops in exactly the person picked — no name-collision guessing on the backend.

export type SerializedMentionNode = Spread<
  { mentionId: string; mentionName: string },
  SerializedTextNode
>;

export class MentionNode extends TextNode {
  __mentionId: string;
  __mentionName: string;

  static getType(): string {
    return "mention";
  }

  static clone(node: MentionNode): MentionNode {
    return new MentionNode(node.__mentionId, node.__mentionName, node.__text, node.__key);
  }

  constructor(mentionId: string, mentionName: string, text?: string, key?: NodeKey) {
    super(text ?? `@${mentionName}`, key);
    this.__mentionId = mentionId;
    this.__mentionName = mentionName;
  }

  getMentionId(): string {
    return this.__mentionId;
  }

  static importJSON(serialized: SerializedMentionNode): MentionNode {
    const node = $createMentionNode(serialized.mentionId, serialized.mentionName);
    node.setTextContent(serialized.text);
    node.setFormat(serialized.format);
    node.setDetail(serialized.detail);
    node.setMode(serialized.mode);
    node.setStyle(serialized.style);
    return node;
  }

  exportJSON(): SerializedMentionNode {
    return {
      ...super.exportJSON(),
      type: "mention",
      version: 1,
      mentionId: this.__mentionId,
      mentionName: this.__mentionName,
    };
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    // Tailwind utility classes — matches the "Looped in" chips on the rendered note.
    dom.className =
      "rounded bg-warning/15 px-1 font-medium text-warning";
    return dom;
  }

  isTextEntity(): true {
    return true;
  }

  canInsertTextBefore(): boolean {
    return false;
  }

  canInsertTextAfter(): boolean {
    return false;
  }
}

export function $createMentionNode(mentionId: string, mentionName: string): MentionNode {
  const node = new MentionNode(mentionId, mentionName);
  // Segmented + directionless: the chip deletes as a unit and stays atomic.
  node.setMode("segmented").toggleDirectionless();
  return $applyNodeReplacement(node);
}

export function $isMentionNode(node: LexicalNode | null | undefined): node is MentionNode {
  return node instanceof MentionNode;
}
