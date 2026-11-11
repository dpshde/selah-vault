import { describe, expect, test } from "bun:test";
import {
  classifyOmni,
  routeOmniSubmit,
  searchInsteadLabel,
  versesToPassageId,
} from "../public/omni.js";

describe("classifyOmni", () => {
  test("empty and whitespace are empty", () => {
    expect(classifyOmni("").kind).toBe("empty");
    expect(classifyOmni("   ").kind).toBe("empty");
    expect(classifyOmni(null).kind).toBe("empty");
  });

  test("a verse or chapter reference is a ref", () => {
    const rom = classifyOmni("Rom 8:18");
    expect(rom.kind).toBe("ref");
    expect(rom.label).toBe("Romans 8:18");
    expect(rom.verses).toEqual(["ROM.8.18"]);

    const range = classifyOmni("Romans 8:18-25");
    expect(range.kind).toBe("ref");
    expect(range.verses[0]).toBe("ROM.8.18");
    expect(range.verses.at(-1)).toBe("ROM.8.25");

    const psa = classifyOmni("Ps 23");
    expect(psa.kind).toBe("ref");
    expect(psa.label).toBe("Psalm 23");
    expect(psa.verses[0]).toBe("PSA.23.1");
  });

  test("bare book names are ambiguous and use the first chapter (or the whole one-chapter book)", () => {
    const job = classifyOmni("Job");
    expect(job.kind).toBe("ambiguous");
    expect(job.book).toBe("JOB");
    expect(job.label).toBe("Job 1");
    expect(job.verses[0]).toBe("JOB.1.1");
    expect(job.search).toBe("Job");

    expect(classifyOmni("job").kind).toBe("ambiguous");
    expect(classifyOmni("JOB").kind).toBe("ambiguous");

    const acts = classifyOmni("Acts");
    expect(acts.kind).toBe("ambiguous");
    expect(acts.label).toBe("Acts 1");

    const john = classifyOmni("John");
    expect(john.kind).toBe("ambiguous");
    expect(john.book).toBe("JHN");
    expect(john.label).toBe("John 1");

    const jude = classifyOmni("Jude");
    expect(jude.kind).toBe("ambiguous");
    expect(jude.book).toBe("JUD");
    // One-chapter book: the whole book, not a guessed chapter.
    expect(jude.verses.length).toBeGreaterThan(1);
    expect(jude.verses[0]).toBe("JUD.1.1");

    const firstJohn = classifyOmni("1 John");
    expect(firstJohn.kind).toBe("ambiguous");
    expect(firstJohn.book).toBe("1JN");
    expect(firstJohn.label).toBe("1 John 1");

    const song = classifyOmni("Song");
    expect(song.kind).toBe("ambiguous");
    expect(song.book).toBe("SNG");

    const kings = classifyOmni("Kings");
    expect(kings.kind).toBe("ambiguous");
    expect(kings.book).toBe("1KI");
    expect(kings.label).toBe("1 Kings 1");

    const jn = classifyOmni("Jn");
    expect(jn.kind).toBe("ambiguous");
    expect(jn.book).toBe("JHN");

    for (const name of ["Mark", "Numbers", "Lamentations", "Revelation", "Judges"]) {
      expect(classifyOmni(name).kind).toBe("ambiguous");
    }
  });

  test("ordinary topic words, including short English words that look like aliases, are topics", () => {
    for (const q of ["hope", "faith", "grace", "love", "is", "am", "he", "re"]) {
      const got = classifyOmni(q);
      expect(got.kind).toBe("topic");
      expect(got.query).toBe(q);
    }
  });
});

describe("routeOmniSubmit", () => {
  test("routes empty to noop, a ref or bare book to the card, and anything else to topic search", () => {
    expect(routeOmniSubmit("").action).toBe("noop");
    expect(routeOmniSubmit("   ").action).toBe("noop");
    expect(routeOmniSubmit("Rom 8:18").action).toBe("card");
    expect(routeOmniSubmit("Rom 8:18").classified.kind).toBe("ref");
    expect(routeOmniSubmit("Job").action).toBe("card");
    expect(routeOmniSubmit("Job").classified.kind).toBe("ambiguous");
    expect(routeOmniSubmit("hope").action).toBe("topic");
    expect(routeOmniSubmit("faith").classified.query).toBe("faith");
  });
});

test("searchInsteadLabel and versesToPassageId format the card chrome", () => {
  expect(searchInsteadLabel("job")).toBe("Search “job” instead");
  expect(searchInsteadLabel("  Job  ")).toBe("Search “Job” instead");
  expect(versesToPassageId(["ROM.8.18"])).toBe("ROM.8.18");
  expect(versesToPassageId(["ROM.8.18", "ROM.8.19", "ROM.8.20"])).toBe("ROM.8.18-20");
  expect(versesToPassageId([])).toBe("");
});
