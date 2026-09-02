import { Schema, type NodeSpec, type MarkSpec } from "prosemirror-model";

const nodes: { [key: string]: NodeSpec } = {
  doc: {
    content: "block*",
  },
  noteTitle: {
    attrs: { emoji: { default: "" } },
    content: "text*",
    group: "block",
    toDOM: () => ["h1", 0],
  },
  paragraph: {
    content: "inline*",
    group: "block",
    toDOM: () => ["p", 0],
  },
  bulletList: {
    content: "listItem+",
    group: "block",
    toDOM: () => ["ul", 0],
  },
  listItem: {
    content: "paragraph block*",
    toDOM: () => ["li", 0],
  },
  // A block container that may be empty, for a clean cross-parent reparent.
  section: {
    content: "block*",
    group: "block",
    toDOM: () => ["section", 0],
  },
  horizontal_rule: {
    group: "block",
    toDOM: () => ["hr"],
    parseDOM: [{ tag: "hr" }],
  },
  text: {
    group: "inline",
  },
};

const marks: { [key: string]: MarkSpec } = {
  bold: {
    toDOM: () => ["strong", 0],
  },
  italic: {
    toDOM: () => ["em", 0],
  },
  // A mark carrying several attributes. Attribute-less marks cannot detect
  // key-order drift between what ProseMirror writes and what Loro returns, so
  // the no-op mark guard in `updateLoroText` is only exercised by a mark
  // shaped like this one.
  link: {
    attrs: {
      href: { default: "" },
      title: { default: "" },
      target: { default: "" },
      pn: { default: "" },
    },
    toDOM: () => ["a", 0],
  },
};

export const schema = new Schema({ nodes, marks });
