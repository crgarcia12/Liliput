import { World, setWorldConstructor } from '@cucumber/cucumber';
import { Browser, BrowserContext, Page, chromium } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

const SCREENSHOT_BASE_DIR = path.resolve(process.cwd(), 'docs', 'screenshots');
const GENERATE_SCREENSHOTS = process.env.GENERATE_SCREENSHOTS === 'true';

export class CustomWorld extends World {
  browser!: Browser;
  context!: BrowserContext;
  page!: Page;

  featureName = '';
  scenarioName = '';
  stepIndex = 0;

  response: { status: number; body: any; headers: Headers } | null = null;
  cookies: string[] = [];
  apiBaseUrl = 'http://localhost:5001';
  webBaseUrl = 'http://localhost:3000';
  storedPasswords: Record<string, string> = {};
  tamperedJwt: string | null = null;

  async apiRequest(method: string, path: string, body?: object): Promise<void> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.cookies.length) headers['Cookie'] = this.cookies.join('; ');
    const options: RequestInit = { method, headers };
    if (body) options.body = JSON.stringify(body);
    const res = await fetch(`${this.apiBaseUrl}${path}`, options);
    const setCookies = res.headers.getSetCookie?.() || [];
    if (setCookies.length) this.cookies = setCookies;
    const responseBody = await res.json().catch(() => null);
    this.response = { status: res.status, body: responseBody, headers: res.headers };
  }

  /** Inject a step overlay bar at the bottom of the page */
  async injectStepOverlay(keyword: string, text: string, status: string): Promise<void> {
    if (!this.page) return;
    try {
      await this.page.evaluate(({ kw, txt, st, idx, scenario }) => {
        document.getElementById('docs-step-overlay')?.remove();
        const el = document.createElement('div');
        el.id = 'docs-step-overlay';
        el.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:linear-gradient(135deg,#1a1a2e,#16213e);color:#fff;padding:12px 20px;z-index:99999;font-family:system-ui,sans-serif;border-top:3px solid #4361ee;display:flex;align-items:center;gap:14px;';
        el.innerHTML = `
          <div style="background:#4361ee;color:#fff;font-size:13px;font-weight:700;border-radius:50%;width:32px;height:32px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">${idx}</div>
          <div style="flex:1;min-width:0;">
            <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:1px;">${scenario}</div>
            <div style="font-size:15px;margin-top:2px;"><span style="color:#4361ee;font-weight:600;">${kw}</span> ${txt}</div>
          </div>
          <div style="font-size:22px;flex-shrink:0;">${st === 'PASSED' ? '✅' : st === 'FAILED' ? '❌' : '⏳'}</div>`;
        document.body.appendChild(el);
      }, { kw: keyword, txt: text, st: status, idx: this.stepIndex, scenario: this.scenarioName });
    } catch { /* best effort */ }
  }

  async openBrowser() {
    this.browser = await chromium.launch();
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    this.page = await this.context.newPage();
  }

  async closeBrowser() {
    await this.context?.close();
    await this.browser?.close();
  }

  get screenshotDir(): string {
    const featureSlug = this.featureName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const scenarioSlug = this.scenarioName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    return path.join(SCREENSHOT_BASE_DIR, featureSlug, scenarioSlug);
  }

  async takeStepScreenshot(stepText: string): Promise<string | undefined> {
    if (!this.page) return undefined;
    const dir = this.screenshotDir;
    fs.mkdirSync(dir, { recursive: true });

    const stepSlug = stepText.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 80);
    const filename = `${String(this.stepIndex).padStart(3, '0')}-${stepSlug}.png`;
    const filepath = path.join(dir, filename);

    try {
      await this.page.screenshot({ path: filepath, fullPage: false });
      return filepath;
    } catch {
      // Page may not be navigated yet — skip silently
      return undefined;
    }
  }
}

setWorldConstructor(CustomWorld);
