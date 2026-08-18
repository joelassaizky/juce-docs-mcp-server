import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, opendir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MASTER_BASE_URL = "https://docs.juce.com/master";
const DEVELOP_BASE_URL = "https://docs.juce.com/develop";
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".juce-docs-mcp-server", "config.json");
const DEFAULT_LOCAL_DOCS_SUBPATH = path.join("docs", "doxygen", "doc");

type ConfigOrigin = "default" | "file" | "env";
export type DocsSourceType = "master" | "develop" | "custom-url" | "local-path";

interface PersistedDocsConfig {
  source?: DocsSourceType;
  customUrl?: string;
  localDocsPath?: string;
  localJucePath?: string;
}

export interface DocsSourceConfig {
  source: DocsSourceType;
  baseUrl?: string;
  localDocsPath?: string;
  localJucePath?: string;
  configPath: string;
  resolvedFrom: ConfigOrigin;
}

export interface SetDocsSourceInput {
  source: DocsSourceType;
  url?: string;
  localDocsPath?: string;
  localJucePath?: string;
}

export interface LocalDocsSetupResult {
  docsPath: string;
  generatedDocs: boolean;
  config: DocsSourceConfig;
}

export interface SourceSearchOptions {
  caseSensitive?: boolean;
  maxResults?: number;
  scope?: "modules" | "all";
}

export interface SourceSearchResult {
  file: string;
  line: number;
  column: number;
  preview: string;
}

export interface SourceFileExcerpt {
  file: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface MemberSearchResult {
  kind: "method" | "property";
  name: string;
  signature: string;
  description: string;
}

/**
 * Represents the structure of JUCE class documentation
 */
export interface ClassDocumentation {
  className: string;
  description: string;
  methods: MethodDocumentation[];
  properties: PropertyDocumentation[];
  inheritance?: string;
  url: string;
}

export interface MethodDocumentation {
  name: string;
  signature: string;
  description: string;
}

export interface PropertyDocumentation {
  name: string;
  type: string;
  description: string;
}

let activeConfig: DocsSourceConfig | null = null;
let classListCache: { key: string; classes: string[] } | null = null;

function getConfigPath(): string {
  const overridePath = process.env.JUCE_DOCS_CONFIG_PATH?.trim();
  return overridePath ? path.resolve(overridePath) : DEFAULT_CONFIG_PATH;
}

function normalizeUrl(inputUrl: string): string {
  return inputUrl.trim().replace(/\/+$/, "");
}

function normalizeClassLookupName(className: string): string {
  return className.trim().replace(/::/g, "_1_1");
}

function getClassLeafName(classIdentifier: string): string {
  const segments = classIdentifier.split("_1_1");
  return segments[segments.length - 1];
}

export function decodeClassIdentifier(classIdentifier: string): string {
  return classIdentifier.replace(/_1_1/g, "::");
}

function docsSourceCacheKey(config: DocsSourceConfig): string {
  if (config.source === "local-path") {
    return `local:${config.localDocsPath}`;
  }
  return `remote:${config.baseUrl}`;
}

function clearCaches(): void {
  classListCache = null;
}

async function pathExists(testPath: string): Promise<boolean> {
  try {
    await access(testPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function parseEnvConfig(configPath: string): DocsSourceConfig | null {
  const sourceFromEnv = process.env.JUCE_DOCS_SOURCE?.trim().toLowerCase();
  const baseUrlFromEnv = process.env.JUCE_DOCS_BASE_URL?.trim();
  const localPathFromEnv = process.env.JUCE_DOCS_LOCAL_PATH?.trim();
  const localJucePathFromEnv = process.env.JUCE_SOURCE_LOCAL_PATH?.trim();

  if (localPathFromEnv && localPathFromEnv.length > 0) {
    const resolvedDocsPath = path.resolve(localPathFromEnv);
    return {
      source: "local-path",
      localDocsPath: resolvedDocsPath,
      localJucePath: localJucePathFromEnv
        ? path.resolve(localJucePathFromEnv)
        : inferJucePathFromDocsPath(resolvedDocsPath),
      configPath,
      resolvedFrom: "env"
    };
  }

  if (sourceFromEnv === "master") {
    return {
      source: "master",
      baseUrl: MASTER_BASE_URL,
      localJucePath: localJucePathFromEnv ? path.resolve(localJucePathFromEnv) : undefined,
      configPath,
      resolvedFrom: "env"
    };
  }

  if (sourceFromEnv === "develop") {
    return {
      source: "develop",
      baseUrl: DEVELOP_BASE_URL,
      localJucePath: localJucePathFromEnv ? path.resolve(localJucePathFromEnv) : undefined,
      configPath,
      resolvedFrom: "env"
    };
  }

  if (sourceFromEnv === "custom-url" || (baseUrlFromEnv && baseUrlFromEnv.length > 0)) {
    if (!baseUrlFromEnv || baseUrlFromEnv.length === 0) {
      console.error("JUCE_DOCS_SOURCE=custom-url set without JUCE_DOCS_BASE_URL; ignoring env override.");
      return null;
    }
    return {
      source: "custom-url",
      baseUrl: normalizeUrl(baseUrlFromEnv),
      localJucePath: localJucePathFromEnv ? path.resolve(localJucePathFromEnv) : undefined,
      configPath,
      resolvedFrom: "env"
    };
  }

  if (sourceFromEnv === "local-path") {
    console.error("JUCE_DOCS_SOURCE=local-path set without JUCE_DOCS_LOCAL_PATH; ignoring env override.");
    return null;
  }

  if (sourceFromEnv && !["master", "develop", "custom-url", "local-path"].includes(sourceFromEnv)) {
    console.error(`Unknown JUCE_DOCS_SOURCE value '${sourceFromEnv}'; ignoring env override.`);
  }

  return null;
}

function resolvePersistedConfig(configPath: string, persisted: PersistedDocsConfig | null): DocsSourceConfig {
  const source = persisted?.source ?? "master";
  const localJucePath = persisted?.localJucePath
    ? path.resolve(persisted.localJucePath)
    : undefined;

  if (source === "develop") {
    return {
      source: "develop",
      baseUrl: DEVELOP_BASE_URL,
      localJucePath,
      configPath,
      resolvedFrom: persisted ? "file" : "default"
    };
  }

  if (source === "custom-url") {
    if (!persisted?.customUrl) {
      return {
        source: "master",
        baseUrl: MASTER_BASE_URL,
        localJucePath,
        configPath,
        resolvedFrom: "default"
      };
    }
    return {
      source: "custom-url",
      baseUrl: normalizeUrl(persisted.customUrl),
      localJucePath,
      configPath,
      resolvedFrom: "file"
    };
  }

  if (source === "local-path") {
    if (!persisted?.localDocsPath) {
      return {
        source: "master",
        baseUrl: MASTER_BASE_URL,
        localJucePath,
        configPath,
        resolvedFrom: "default"
      };
    }
    return {
      source: "local-path",
      localDocsPath: path.resolve(persisted.localDocsPath),
      localJucePath,
      configPath,
      resolvedFrom: "file"
    };
  }

  return {
    source: "master",
    baseUrl: MASTER_BASE_URL,
    localJucePath,
    configPath,
    resolvedFrom: persisted ? "file" : "default"
  };
}

async function loadPersistedConfig(configPath: string): Promise<PersistedDocsConfig | null> {
  if (!(await pathExists(configPath))) {
    return null;
  }

  try {
    const raw = await readFile(configPath, "utf-8");
    return JSON.parse(raw) as PersistedDocsConfig;
  } catch (error) {
    console.error(`Failed to parse config file '${configPath}', falling back to defaults:`, error);
    return null;
  }
}

async function savePersistedConfig(configPath: string, persisted: PersistedDocsConfig): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf-8");
}

async function ensureLocalDocsPathLooksValid(localDocsPath: string): Promise<void> {
  const annotatedPath = path.join(localDocsPath, "annotated.html");
  if (!(await pathExists(annotatedPath))) {
    throw new Error(
      `Local docs path does not look valid: '${localDocsPath}' is missing annotated.html. ` +
      "Generate docs first or provide a docs directory that contains annotated.html and class*.html."
    );
  }
}

async function ensureLocalJucePathLooksValid(localJucePath: string): Promise<void> {
  const modulesPath = path.join(localJucePath, "modules");
  if (!(await pathExists(modulesPath))) {
    throw new Error(
      `Local JUCE path does not look valid: '${localJucePath}' is missing the modules directory.`
    );
  }
}

function inferJucePathFromDocsPath(localDocsPath: string): string | undefined {
  const suffix = path.join("docs", "doxygen", "doc");
  const normalized = path.resolve(localDocsPath);
  return normalized.endsWith(suffix)
    ? normalized.slice(0, -(suffix.length + 1))
    : undefined;
}

export function getDocsConfigPath(): string {
  return getConfigPath();
}

export async function getDocsSourceConfig(): Promise<DocsSourceConfig> {
  if (activeConfig) {
    return activeConfig;
  }

  const configPath = getConfigPath();
  const envConfig = parseEnvConfig(configPath);
  if (envConfig) {
    activeConfig = envConfig;
    return envConfig;
  }

  const persistedConfig = await loadPersistedConfig(configPath);
  activeConfig = resolvePersistedConfig(configPath, persistedConfig);
  return activeConfig;
}

export async function setDocsSourceConfig(input: SetDocsSourceInput): Promise<DocsSourceConfig> {
  const configPath = getConfigPath();
  let persisted: PersistedDocsConfig;
  const currentConfig = activeConfig ?? resolvePersistedConfig(
    configPath,
    await loadPersistedConfig(configPath)
  );
  const explicitJucePath = input.localJucePath
    ? path.resolve(input.localJucePath)
    : currentConfig.localJucePath;

  if (explicitJucePath) {
    await ensureLocalJucePathLooksValid(explicitJucePath);
  }

  if (input.source === "master") {
    persisted = { source: "master", localJucePath: explicitJucePath };
  } else if (input.source === "develop") {
    persisted = { source: "develop", localJucePath: explicitJucePath };
  } else if (input.source === "custom-url") {
    if (!input.url) {
      throw new Error("A URL is required when source='custom-url'.");
    }
    persisted = {
      source: "custom-url",
      customUrl: normalizeUrl(input.url),
      localJucePath: explicitJucePath
    };
  } else {
    if (!input.localDocsPath) {
      throw new Error("A local docs path is required when source='local-path'.");
    }
    const resolvedLocalPath = path.resolve(input.localDocsPath);
    await ensureLocalDocsPathLooksValid(resolvedLocalPath);
    const inferredJucePath = explicitJucePath ?? inferJucePathFromDocsPath(resolvedLocalPath);
    if (inferredJucePath) {
      await ensureLocalJucePathLooksValid(inferredJucePath);
    }
    persisted = {
      source: "local-path",
      localDocsPath: resolvedLocalPath,
      localJucePath: inferredJucePath
    };
  }

  await savePersistedConfig(configPath, persisted);
  activeConfig = resolvePersistedConfig(configPath, persisted);
  clearCaches();
  return activeConfig;
}

interface RunCommandResult {
  code: number;
  combinedOutput: string;
}

async function runCommand(command: string, args: string[], cwd: string): Promise<RunCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false });
    let output = "";

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      resolve({ code: code ?? 1, combinedOutput: output.slice(-12000) });
    });
  });
}

async function runLocalDocsBuild(doxygenDir: string): Promise<void> {
  const pythonOptions =
    process.platform === "win32"
      ? [
          { command: "py", args: ["-3", "build.py"] },
          { command: "python", args: ["build.py"] }
        ]
      : [
          { command: "python3", args: ["build.py"] },
          { command: "python", args: ["build.py"] }
        ];

  let lastError: unknown = null;
  for (const option of pythonOptions) {
    try {
      const result = await runCommand(option.command, option.args, doxygenDir);
      if (result.code === 0) {
        return;
      }
      throw new Error(
        `Command '${option.command} ${option.args.join(" ")}' exited with code ${result.code}.\n${result.combinedOutput}`
      );
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Unable to generate local JUCE docs via build.py.\n${String(lastError)}`);
}

function resolveDocsPathFromJucePath(jucePath: string): string {
  const resolvedInput = path.resolve(jucePath);
  return path.join(resolvedInput, DEFAULT_LOCAL_DOCS_SUBPATH);
}

export async function setupLocalDocsFromJucePath(
  jucePath: string,
  generateIfMissing = false
): Promise<LocalDocsSetupResult> {
  const resolvedInput = path.resolve(jucePath);
  const directDocsPath = resolvedInput;
  const derivedDocsPath = resolveDocsPathFromJucePath(resolvedInput);

  let docsPathToUse: string | null = null;
  if (await pathExists(path.join(directDocsPath, "annotated.html"))) {
    docsPathToUse = directDocsPath;
  } else if (await pathExists(path.join(derivedDocsPath, "annotated.html"))) {
    docsPathToUse = derivedDocsPath;
  }

  let generatedDocs = false;
  if (!docsPathToUse && generateIfMissing) {
    const doxygenDir = path.join(resolvedInput, "docs", "doxygen");
    if (!(await pathExists(doxygenDir))) {
      throw new Error(
        `Could not find '${doxygenDir}'. Provide either a JUCE repo root path or an existing docs directory.`
      );
    }

    await runLocalDocsBuild(doxygenDir);
    generatedDocs = true;

    if (await pathExists(path.join(derivedDocsPath, "annotated.html"))) {
      docsPathToUse = derivedDocsPath;
    }
  }

  if (!docsPathToUse) {
    throw new Error(
      "Could not locate local JUCE docs. Expected either:\n" +
      `- ${path.join(directDocsPath, "annotated.html")}\n` +
      `- ${path.join(derivedDocsPath, "annotated.html")}\n` +
      "Set generateIfMissing=true to generate docs from a JUCE repo checkout."
    );
  }

  const config = await setDocsSourceConfig({
    source: "local-path",
    localDocsPath: docsPathToUse,
    localJucePath: await pathExists(path.join(resolvedInput, "modules"))
      ? resolvedInput
      : inferJucePathFromDocsPath(docsPathToUse)
  });

  return { docsPath: docsPathToUse, generatedDocs, config };
}

interface HtmlFetchResult {
  html: string | null;
  resolvedLocation: string;
}

async function fetchHtml(relativePath: string, allowNotFound = false): Promise<HtmlFetchResult> {
  const config = await getDocsSourceConfig();
  const cleanRelativePath = relativePath.replace(/^\/+/, "");

  if (config.source === "local-path") {
    const localDocsPath = config.localDocsPath;
    if (!localDocsPath) {
      throw new Error("Local docs source is configured but localDocsPath is missing.");
    }

    const filePath = path.join(localDocsPath, cleanRelativePath);
    if (!(await pathExists(filePath))) {
      if (allowNotFound) {
        return { html: null, resolvedLocation: pathToFileURL(filePath).href };
      }
      throw new Error(`Local docs file not found: ${filePath}`);
    }

    const html = await readFile(filePath, "utf-8");
    return { html, resolvedLocation: pathToFileURL(filePath).href };
  }

  const baseUrl = config.baseUrl;
  if (!baseUrl) {
    throw new Error("Remote docs source is configured but baseUrl is missing.");
  }

  const fullUrl = `${baseUrl}/${cleanRelativePath}`;
  const response = await fetch(fullUrl);
  if (!response.ok) {
    if (allowNotFound && response.status === 404) {
      return { html: null, resolvedLocation: fullUrl };
    }
    throw new Error(`Failed to fetch ${fullUrl}: ${response.status} ${response.statusText}`);
  }

  return {
    html: await response.text(),
    resolvedLocation: response.url || fullUrl
  };
}

/**
 * Fetches the list of all JUCE classes from the index page
 */
export function parseClassListHtml(html: string): string[] {
  const $ = cheerio.load(html);
  const classes: string[] = [];

  $(".directory tr.even, .directory tr.odd").each((_, element) => {
    const link = $(element).find("td.entry a");
    const href = link.attr("href");
    if (href && href.startsWith("class") && href.endsWith(".html")) {
      classes.push(href.replace(/^class/, "").replace(/\.html$/, ""));
    }
  });

  return [...new Set(classes)];
}

export async function fetchClassList(): Promise<string[]> {
  try {
    const config = await getDocsSourceConfig();
    const cacheKey = docsSourceCacheKey(config);

    if (classListCache && classListCache.key === cacheKey) {
      return classListCache.classes;
    }

    const { html } = await fetchHtml("annotated.html");
    if (!html) {
      throw new Error("Failed to load annotated.html");
    }

    const classes = parseClassListHtml(html);

    classListCache = { key: cacheKey, classes };
    return classes;
  } catch (error) {
    console.error("Error fetching class list:", error);
    throw error;
  }
}

export function parseClassDocumentationHtml(
  classIdentifier: string,
  classDocUrl: string,
  html: string
): ClassDocumentation {
  const $ = cheerio.load(html);
  const description = $(".contents .textblock").first().text().trim();
  const methods: MethodDocumentation[] = [];

  $(".memitem").each((_, element) => {
    const nameElement = $(element).find(".memname");
    if (!nameElement.length) {
      return;
    }

    const name = nameElement.text().trim().split("(")[0].trim();
    const signature = nameElement.parent().text().replace(/\s+/g, " ").trim();
    const methodDescription = $(element).find(".memdoc").text().replace(/\s+/g, " ").trim();
    methods.push({ name, signature, description: methodDescription });
  });

  const properties: PropertyDocumentation[] = [];
  $(".fieldtable tr").each((_, element) => {
    const nameElement = $(element).find(".fieldname");
    if (!nameElement.length) {
      return;
    }

    properties.push({
      name: nameElement.text().trim(),
      type: $(element).find(".fieldtype").text().trim(),
      description: $(element).find(".fielddoc").text().replace(/\s+/g, " ").trim()
    });
  });

  const inheritance = $(".inheritance").first().text().replace(/\s+/g, " ").trim() || undefined;

  return {
    className: decodeClassIdentifier(classIdentifier),
    description,
    methods,
    properties,
    inheritance,
    url: classDocUrl
  };
}

async function resolveClassIdentifier(className: string): Promise<string> {
  const allClasses = await fetchClassList();
  const normalizedLookup = normalizeClassLookupName(className);
  const normalizedLookupLower = normalizedLookup.toLowerCase();

  const exactMatch = allClasses.find((item) => item.toLowerCase() === normalizedLookupLower);
  if (exactMatch) {
    return exactMatch;
  }

  const lookupLeaf = getClassLeafName(normalizedLookup).toLowerCase();
  const leafMatch = allClasses.find((item) => getClassLeafName(item).toLowerCase() === lookupLeaf);
  if (leafMatch) {
    return leafMatch;
  }

  return normalizedLookup;
}

/**
 * Fetches and parses documentation for a specific JUCE class
 */
export async function fetchClassDocumentation(className: string): Promise<ClassDocumentation | null> {
  try {
    const normalizedLookup = normalizeClassLookupName(className);
    const resolvedClassId = await resolveClassIdentifier(normalizedLookup);
    const classCandidates = [normalizedLookup];
    if (!classCandidates.includes(resolvedClassId)) {
      classCandidates.push(resolvedClassId);
    }

    let classHtml: string | null = null;
    let classDocUrl = "";
    for (const candidate of classCandidates) {
      const result = await fetchHtml(`class${candidate}.html`, true);
      if (result.html) {
        classHtml = result.html;
        classDocUrl = result.resolvedLocation;
        break;
      }
    }

    if (!classHtml) {
      return null;
    }

    return parseClassDocumentationHtml(resolvedClassId, classDocUrl, classHtml);
  } catch (error) {
    console.error(`Error fetching documentation for ${className}:`, error);
    return null;
  }
}

/**
 * Searches for classes matching a query string
 */
export async function searchClasses(query: string): Promise<string[]> {
  try {
    const allClasses = await fetchClassList();
    const lowerQuery = query.toLowerCase();

    return allClasses.filter((className) => className.toLowerCase().includes(lowerQuery));
  } catch (error) {
    console.error("Error searching classes:", error);
    throw error;
  }
}

export async function searchClassMembers(
  className: string,
  query: string
): Promise<MemberSearchResult[]> {
  const doc = await fetchClassDocumentation(className);
  if (!doc) {
    return [];
  }

  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [];
  }

  const methods: MemberSearchResult[] = doc.methods
    .filter((method) =>
      [method.name, method.signature, method.description]
        .some((value) => value.toLowerCase().includes(needle))
    )
    .map((method) => ({
      kind: "method",
      name: method.name,
      signature: method.signature,
      description: method.description
    }));

  const properties: MemberSearchResult[] = doc.properties
    .filter((property) =>
      [property.name, property.type, property.description]
        .some((value) => value.toLowerCase().includes(needle))
    )
    .map((property) => ({
      kind: "property",
      name: property.name,
      signature: property.type,
      description: property.description
    }));

  return [...methods, ...properties];
}

const SOURCE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hh",
  ".hpp",
  ".inl",
  ".m",
  ".mm"
]);

const EXCLUDED_SOURCE_DIRECTORIES = new Set([
  ".git",
  "build",
  "Builds",
  "cmake-build-debug",
  "cmake-build-release",
  "node_modules"
]);

async function requireLocalJucePath(): Promise<string> {
  const config = await getDocsSourceConfig();
  if (!config.localJucePath) {
    throw new Error(
      "JUCE source lookup requires a local JUCE checkout. " +
      "Run setup-local-juce-docs or set JUCE_SOURCE_LOCAL_PATH."
    );
  }

  await ensureLocalJucePathLooksValid(config.localJucePath);
  return config.localJucePath;
}

async function* walkSourceFiles(directory: string): AsyncGenerator<string> {
  const entries = await opendir(directory);
  for await (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }

    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_SOURCE_DIRECTORIES.has(entry.name)) {
        yield* walkSourceFiles(entryPath);
      }
      continue;
    }

    if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      yield entryPath;
    }
  }
}

function clampResultCount(value: number | undefined): number {
  return Math.max(1, Math.min(value ?? 20, 100));
}

async function searchSourceTreeWithRipgrep(
  rootPath: string,
  searchRoot: string,
  query: string,
  options: SourceSearchOptions,
  maxResults: number
): Promise<SourceSearchResult[] | null> {
  return new Promise((resolve, reject) => {
    const args = [
      "--json",
      "--fixed-strings",
      "--max-filesize",
      "4M",
      options.caseSensitive ? "--case-sensitive" : "--ignore-case",
      "--glob",
      "*.{c,cc,cpp,cxx,h,hh,hpp,inl,m,mm}",
      "--glob",
      "!build/**",
      "--glob",
      "!Builds/**",
      "--glob",
      "!node_modules/**",
      "--",
      query,
      searchRoot
    ];
    const child = spawn("rg", args, { shell: false });
    const results: SourceSearchResult[] = [];
    let buffered = "";
    let settled = false;

    const finish = (value: SourceSearchResult[] | null): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    const processLine = (line: string): void => {
      if (!line || results.length >= maxResults) {
        return;
      }

      let event: {
        type?: string;
        data?: {
          path?: { text?: string };
          line_number?: number;
          lines?: { text?: string };
          submatches?: Array<{ start?: number }>;
        };
      };
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }

      if (event.type !== "match") {
        return;
      }

      const filePath = event.data?.path?.text;
      const lineNumber = event.data?.line_number;
      const preview = event.data?.lines?.text;
      if (!filePath || !lineNumber || preview === undefined) {
        return;
      }

      results.push({
        file: path.relative(rootPath, filePath).split(path.sep).join("/"),
        line: lineNumber,
        column: (event.data?.submatches?.[0]?.start ?? 0) + 1,
        preview: preview.trim().slice(0, 500)
      });

      if (results.length >= maxResults) {
        child.kill();
      }
    };

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      lines.forEach(processLine);
    });

    child.stderr.on("data", () => {
      // Ripgrep diagnostics are handled by its exit status.
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        finish(null);
      } else {
        reject(error);
      }
    });

    child.on("close", (code) => {
      processLine(buffered);
      if (settled) {
        return;
      }
      if (code === 0 || code === 1 || results.length >= maxResults) {
        finish(results);
      } else {
        reject(new Error(`ripgrep source search exited with code ${code ?? "unknown"}.`));
      }
    });
  });
}

export async function searchSourceTree(
  jucePath: string,
  query: string,
  options: SourceSearchOptions = {}
): Promise<SourceSearchResult[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    throw new Error("Source search query must not be empty.");
  }

  const rootPath = await realpath(jucePath);
  await ensureLocalJucePathLooksValid(rootPath);
  const searchRoot = options.scope === "all"
    ? rootPath
    : path.join(rootPath, "modules");
  const needle = options.caseSensitive ? trimmedQuery : trimmedQuery.toLowerCase();
  const maxResults = clampResultCount(options.maxResults);
  const ripgrepResults = await searchSourceTreeWithRipgrep(
    rootPath,
    searchRoot,
    trimmedQuery,
    options,
    maxResults
  );
  if (ripgrepResults) {
    return ripgrepResults;
  }

  const results: SourceSearchResult[] = [];

  for await (const filePath of walkSourceFiles(searchRoot)) {
    const fileStats = await stat(filePath);
    if (fileStats.size > 4 * 1024 * 1024) {
      continue;
    }

    const contents = await readFile(filePath, "utf-8");
    const lines = contents.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const haystack = options.caseSensitive ? lines[lineIndex] : lines[lineIndex].toLowerCase();
      const column = haystack.indexOf(needle);
      if (column < 0) {
        continue;
      }

      results.push({
        file: path.relative(rootPath, filePath).split(path.sep).join("/"),
        line: lineIndex + 1,
        column: column + 1,
        preview: lines[lineIndex].trim().slice(0, 500)
      });

      if (results.length >= maxResults) {
        return results;
      }
    }
  }

  return results;
}

export async function searchJuceSource(
  query: string,
  options: SourceSearchOptions = {}
): Promise<SourceSearchResult[]> {
  return searchSourceTree(await requireLocalJucePath(), query, options);
}

function validateSourceRelativePath(relativePath: string): void {
  if (
    path.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]+/).some((part) => part === ".." || part.startsWith("."))
  ) {
    throw new Error("Source file path must stay within the configured JUCE checkout.");
  }

  if (!SOURCE_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) {
    throw new Error("Source file must be a C, C++, Objective-C, or header file.");
  }
}

export async function readSourceFileFromTree(
  jucePath: string,
  relativePath: string,
  startLine = 1,
  endLine?: number
): Promise<SourceFileExcerpt> {
  validateSourceRelativePath(relativePath);
  const rootPath = await realpath(jucePath);
  const requestedPath = await realpath(path.resolve(rootPath, relativePath));
  const rootPrefix = rootPath.endsWith(path.sep) ? rootPath : `${rootPath}${path.sep}`;
  if (!requestedPath.startsWith(rootPrefix)) {
    throw new Error("Source file path escapes the configured JUCE checkout.");
  }

  const fileStats = await stat(requestedPath);
  if (!fileStats.isFile() || fileStats.size > 4 * 1024 * 1024) {
    throw new Error("Source file is unavailable or exceeds the 4 MiB read limit.");
  }

  const lines = (await readFile(requestedPath, "utf-8")).split(/\r?\n/);
  const safeStart = Math.max(1, Math.min(startLine, Math.max(lines.length, 1)));
  const requestedEnd = endLine ?? Math.min(safeStart + 199, lines.length);
  const safeEnd = Math.max(safeStart, Math.min(requestedEnd, safeStart + 399, lines.length));

  return {
    file: path.relative(rootPath, requestedPath).split(path.sep).join("/"),
    startLine: safeStart,
    endLine: safeEnd,
    content: lines.slice(safeStart - 1, safeEnd).join("\n")
  };
}

export async function readJuceSourceFile(
  relativePath: string,
  startLine = 1,
  endLine?: number
): Promise<SourceFileExcerpt> {
  return readSourceFileFromTree(
    await requireLocalJucePath(),
    relativePath,
    startLine,
    endLine
  );
}

export function formatMemberSearchResults(
  className: string,
  query: string,
  results: MemberSearchResult[]
): string {
  if (results.length === 0) {
    return `No members of '${className}' matched '${query}'.`;
  }

  const body = results.map((result) =>
    `### ${result.name} (${result.kind})\n\n` +
    `\`\`\`cpp\n${result.signature}\n\`\`\`\n\n` +
    result.description
  ).join("\n\n");
  return `# Members of ${className} matching '${query}'\n\n${body}`;
}

export function formatSourceSearchResults(
  query: string,
  results: SourceSearchResult[]
): string {
  if (results.length === 0) {
    return `No JUCE source lines matched '${query}'.`;
  }

  return `# JUCE source matches for '${query}'\n\n` +
    results.map((result) =>
      `- \`${result.file}:${result.line}:${result.column}\` — \`${result.preview}\``
    ).join("\n");
}

export function formatSourceExcerpt(excerpt: SourceFileExcerpt): string {
  return `# ${excerpt.file}\n\nLines ${excerpt.startLine}-${excerpt.endLine}\n\n` +
    `\`\`\`cpp\n${excerpt.content}\n\`\`\``;
}

/**
 * Formats class documentation as markdown
 */
export function formatClassDocumentation(doc: ClassDocumentation): string {
  let markdown = `# ${doc.className}\n\n`;

  if (doc.inheritance) {
    markdown += `**Inheritance:** ${doc.inheritance}\n\n`;
  }

  markdown += `${doc.description}\n\n`;
  markdown += `[View Documentation Source](${doc.url})\n\n`;

  if (doc.methods.length > 0) {
    markdown += "## Methods\n\n";
    doc.methods.forEach((method) => {
      markdown += `### ${method.name}\n\n`;
      markdown += `\`\`\`cpp\n${method.signature}\n\`\`\`\n\n`;
      markdown += `${method.description}\n\n`;
    });
  }

  if (doc.properties.length > 0) {
    markdown += "## Properties\n\n";
    doc.properties.forEach((prop) => {
      markdown += `### ${prop.name}\n\n`;
      markdown += `**Type:** ${prop.type}\n\n`;
      markdown += `${prop.description}\n\n`;
    });
  }

  return markdown;
}
