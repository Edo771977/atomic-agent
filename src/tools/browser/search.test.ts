import { describe, expect, it } from "vitest";

import type { DangerousToolOptions } from "../../approval/dangerous-tool.js";
import { BROWSER_PAGE_SOURCE } from "../untrusted-tool-output.js";
import type { BrowserBackend } from "./browser-backend.js";
import { buildBrowserSearchTool } from "./search.js";

describe("browser.search", () => {
  it("declares its output as a web page's text: the results page lands in ### world", () => {
    const tool = buildBrowserSearchTool({} as BrowserBackend, {} as DangerousToolOptions);
    expect(tool.untrustedOutput).toBe(BROWSER_PAGE_SOURCE);
  });
});
