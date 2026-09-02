import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type MockInstance,
  test,
  vi,
} from "vitest";

import { LoroDoc, LoroList, LoroMap, LoroText } from "loro-crdt";

import {
  ATTRIBUTES_KEY,
  CHILDREN_KEY,
  ROOT_DOC_KEY,
  tryGetLoroMapAttributes,
  tryGetLoroMapChildren,
  type LoroDocType,
} from "../src/lib";

/**
 * The read/write container-accessor
 * split: `tryGetLoroMapAttributes` /
 * `tryGetLoroMapChildren` only checked `!= null` before casting `obj.get(KEY)`
 * to a container. On a malformed/version-skewed doc where a primitive `Value`
 * was written under the `attributes`/`children` key instead of a container,
 * that cast is a lie: the caller crashes at `.toJSON()` / `.toArray()` instead
 * of getting the safe "absent" signal the read path promises everywhere else.
 */
describe("tryGet* guard against a primitive stored under the container key", () => {
  let warnSpy: MockInstance<Parameters<Console["warn"]>, void>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  test("tryGetLoroMapAttributes returns undefined when the attributes key holds a primitive Value", () => {
    const doc: LoroDocType = new LoroDoc();
    const root = doc.getMap(ROOT_DOC_KEY);
    root.set("nodeName", "doc");
    // Malformed doc: a string where a LoroMap container should be.
    (root as unknown as LoroMap).set(ATTRIBUTES_KEY, "not-a-container");
    doc.commit();

    expect(tryGetLoroMapAttributes(root)).toBeUndefined();
  });

  test("tryGetLoroMapChildren returns undefined when the children key holds a primitive Value", () => {
    const doc: LoroDocType = new LoroDoc();
    const root = doc.getMap(ROOT_DOC_KEY);
    root.set("nodeName", "doc");
    // Malformed doc: a number where a LoroList container should be.
    (root as unknown as LoroMap).set(CHILDREN_KEY, 42);
    doc.commit();

    expect(tryGetLoroMapChildren(root)).toBeUndefined();
  });

  test("warns when a primitive Value is found under the attributes key (corruption signal)", () => {
    const doc: LoroDocType = new LoroDoc();
    const root = doc.getMap(ROOT_DOC_KEY);
    root.set("nodeName", "doc");
    (root as unknown as LoroMap).set(ATTRIBUTES_KEY, "not-a-container");
    doc.commit();

    tryGetLoroMapAttributes(root);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain(ATTRIBUTES_KEY);
  });

  test("warns when a primitive Value is found under the children key (corruption signal)", () => {
    const doc: LoroDocType = new LoroDoc();
    const root = doc.getMap(ROOT_DOC_KEY);
    root.set("nodeName", "doc");
    (root as unknown as LoroMap).set(CHILDREN_KEY, 42);
    doc.commit();

    tryGetLoroMapChildren(root);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain(CHILDREN_KEY);
  });

  test("does NOT warn when the attributes/children key is simply absent (legitimate on historical frontiers)", () => {
    const doc: LoroDocType = new LoroDoc();
    const root = doc.getMap(ROOT_DOC_KEY);
    root.set("nodeName", "doc");
    doc.commit();

    expect(tryGetLoroMapAttributes(root)).toBeUndefined();
    expect(tryGetLoroMapChildren(root)).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

/**
 * A container-vs-primitive check is not enough: a container of the WRONG KIND
 * passes it, gets cast to the expected type, and still crashes downstream — a
 * `LoroMap` under `children` has no `.toArray()`, a `LoroText` under
 * `attributes` yields a string from `.toJSON()` where the caller spreads an
 * attribute object. Same malformed/version-skewed-doc threat model as the
 * primitive case above; the kind check subsumes it at the same cost.
 */
describe("tryGet* guard against a wrong-KIND container under the container key", () => {
  let warnSpy: MockInstance<Parameters<Console["warn"]>, void>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  test("tryGetLoroMapChildren returns undefined when the children key holds a LoroMap", () => {
    const doc: LoroDocType = new LoroDoc();
    const root = doc.getMap(ROOT_DOC_KEY);
    root.set("nodeName", "doc");
    // Malformed doc: a LoroMap where a LoroList container should be.
    (root as unknown as LoroMap).setContainer(CHILDREN_KEY, new LoroMap());
    doc.commit();

    expect(tryGetLoroMapChildren(root)).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain(CHILDREN_KEY);
  });

  test("tryGetLoroMapAttributes returns undefined when the attributes key holds a LoroText", () => {
    const doc: LoroDocType = new LoroDoc();
    const root = doc.getMap(ROOT_DOC_KEY);
    root.set("nodeName", "doc");
    // Malformed doc: a LoroText where a LoroMap container should be.
    (root as unknown as LoroMap).setContainer(ATTRIBUTES_KEY, new LoroText());
    doc.commit();

    expect(tryGetLoroMapAttributes(root)).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain(ATTRIBUTES_KEY);
  });

  test("tryGetLoroMapAttributes returns undefined when the attributes key holds a LoroList", () => {
    const doc: LoroDocType = new LoroDoc();
    const root = doc.getMap(ROOT_DOC_KEY);
    root.set("nodeName", "doc");
    (root as unknown as LoroMap).setContainer(ATTRIBUTES_KEY, new LoroList());
    doc.commit();

    expect(tryGetLoroMapAttributes(root)).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test("a healthy doc's attributes/children still resolve to their containers", () => {
    const doc: LoroDocType = new LoroDoc();
    const root = doc.getMap(ROOT_DOC_KEY);
    root.set("nodeName", "doc");
    (root as unknown as LoroMap).setContainer(ATTRIBUTES_KEY, new LoroMap());
    (root as unknown as LoroMap).setContainer(CHILDREN_KEY, new LoroList());
    doc.commit();

    expect(tryGetLoroMapAttributes(root)).toBeInstanceOf(LoroMap);
    expect(tryGetLoroMapChildren(root)).toBeInstanceOf(LoroList);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
