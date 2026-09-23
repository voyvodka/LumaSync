import { describe, expect, it } from "vitest";

import { isEditableTarget } from "../editableTarget";

describe("isEditableTarget", () => {
  it.each(["input", "textarea", "select"])("claims a <%s>", (tag) => {
    expect(isEditableTarget(document.createElement(tag))).toBe(true);
  });

  it("claims a contenteditable region", () => {
    const div = document.createElement("div");
    div.contentEditable = "true";
    document.body.appendChild(div);
    expect(isEditableTarget(div)).toBe(true);
    div.remove();
  });

  it("leaves buttons, plain elements and non-elements to the app", () => {
    expect(isEditableTarget(document.createElement("button"))).toBe(false);
    expect(isEditableTarget(document.createElement("div"))).toBe(false);
    expect(isEditableTarget(document)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});
