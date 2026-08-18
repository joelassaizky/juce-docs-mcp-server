import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  formatSourceExcerpt,
  parseClassDocumentationHtml,
  parseClassListHtml,
  readSourceFileFromTree,
  searchSourceTree
} from "./juce-docs.js";

test("parses namespaced JUCE 9 class identifiers from Doxygen", () => {
  const html = `
    <table class="directory">
      <tr class="even"><td class="entry"><a href="classjuce_1_1AudioProcessorGraph.html">AudioProcessorGraph</a></td></tr>
      <tr class="odd"><td class="entry"><a href="classjuce_1_1AudioPluginInstance.html">AudioPluginInstance</a></td></tr>
      <tr class="even"><td class="entry"><a href="classjuce_1_1AudioProcessorGraph.html">duplicate</a></td></tr>
    </table>
  `;

  assert.deepEqual(parseClassListHtml(html), [
    "juce_1_1AudioProcessorGraph",
    "juce_1_1AudioPluginInstance"
  ]);
});

test("parses JUCE 9 class descriptions and members", () => {
  const html = `
    <div class="inheritance">juce::AudioProcessor</div>
    <div class="contents">
      <div class="textblock">A graph of audio processors.</div>
      <div class="memitem">
        <table><tr><td class="memname">Node::Ptr juce::AudioProcessorGraph::addNode (std::unique_ptr&lt; AudioProcessor &gt;)</td></tr></table>
        <div class="memdoc">Adds a processor to the graph.</div>
      </div>
      <table class="fieldtable">
        <tr><td class="fieldtype">enum class</td><td class="fieldname">UpdateKind</td><td class="fielddoc">Controls graph rebuilding.</td></tr>
      </table>
    </div>
  `;

  const doc = parseClassDocumentationHtml(
    "juce_1_1AudioProcessorGraph",
    "file:///tmp/classjuce_1_1AudioProcessorGraph.html",
    html
  );

  assert.equal(doc.className, "juce::AudioProcessorGraph");
  assert.equal(doc.description, "A graph of audio processors.");
  assert.equal(doc.methods.length, 1);
  assert.match(doc.methods[0].signature, /addNode/);
  assert.equal(doc.properties[0].name, "UpdateKind");
  assert.equal(doc.inheritance, "juce::AudioProcessor");
});

test("searches and reads a bounded local JUCE source tree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "juce-docs-test-"));
  try {
    const modulePath = path.join(root, "modules", "juce_audio_processors");
    await mkdir(modulePath, { recursive: true });
    await writeFile(
      path.join(modulePath, "juce_AudioProcessorGraph.cpp"),
      [
        "namespace juce {",
        "void AudioProcessorGraph::rebuild() {}",
        "}"
      ].join("\n"),
      "utf-8"
    );

    const matches = await searchSourceTree(root, "audioprocessorgraph::rebuild", {
      maxResults: 5
    });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].file, "modules/juce_audio_processors/juce_AudioProcessorGraph.cpp");
    assert.equal(matches[0].line, 2);

    const excerpt = await readSourceFileFromTree(root, matches[0].file, 2, 2);
    assert.equal(excerpt.content, "void AudioProcessorGraph::rebuild() {}");
    assert.match(formatSourceExcerpt(excerpt), /```cpp/);

    await assert.rejects(
      readSourceFileFromTree(root, "../outside.cpp"),
      /stay within/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
