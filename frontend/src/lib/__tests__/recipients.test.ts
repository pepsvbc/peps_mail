import { describe, expect, it } from "vitest";
import { formatRecipient, parseRecipients } from "../recipients";
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
