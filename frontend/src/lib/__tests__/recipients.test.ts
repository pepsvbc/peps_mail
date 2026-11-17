import { describe, expect, it } from "vitest";
import {
  decodeListRecipient, encodeListRecipient, expandRecipients, formatRecipient, isListRecipientToken,
  parseMailboxList, parseRecipients, serializeRecipientField,
} from "../recipients";
import { countRecipients } from "@/components/mail/ComposeDialog/utils";

describe("recipient addresses", () => {
  it("keeps a quoted comma inside a single recipient when sending and counting", () => {
    const value = '"Doe, Jane" <jane@example.com>; coach@example.com, ';
    expect(parseRecipients(value)).toEqual(['"Doe, Jane" <jane@example.com>', "coach@example.com"]);
    expect(countRecipients(value)).toBe(2);
  });

  it.each(['Doe, Jane', 'Jane "Coach" Doe', 'Jane\\'])("round-trips a suggested name: %s", (name) => {
    const formatted = formatRecipient("jane@example.com", name);
    expect(parseRecipients(`${formatted}, other@example.com`)).toEqual([formatted, "other@example.com"]);
  });
});

describe("distribution-list recipients", () => {
  it("parses pasted addresses separated by commas, semicolons or newlines", () => {
    expect(parseMailboxList('Jean Dupont <jean@example.com>; lea@example.com\n"Martin, Paul" <paul@example.com>,, oops')).toEqual({
      valid: [
        { email: "jean@example.com", name: "Jean Dupont" },
        { email: "lea@example.com", name: "" },
        { email: "paul@example.com", name: "Martin, Paul" },
      ],
      invalid: ["oops"],
    });
  });

  it("round-trips a list chip and never leaks it into the expanded addresses", () => {
    const list = { id: "u13", name: 'Équipe "U13"; A', members: [{ email: "a@example.com", name: "Doe, Jane" }, { email: "b@example.com", name: "" }] };
    const chip = encodeListRecipient(list);
    expect(isListRecipientToken(chip)).toBe(true);
    expect(parseRecipients(`${chip}, c@example.com`)).toEqual([chip, "c@example.com"]);
    expect(decodeListRecipient(chip)).toEqual(list);
    expect(expandRecipients(`B@example.com, ${chip}`)).toEqual(["B@example.com", '"Doe, Jane" <a@example.com>']);
    expect(serializeRecipientField(`${chip}, c@example.com`)).toBe('"Doe, Jane" <a@example.com>, b@example.com, c@example.com');
    expect(expandRecipients("@list:%7Bbroken")).toEqual([]);
  });
});
