import { Before, After, AfterStep, BeforeAll, AfterAll, setDefaultTimeout } from '@cucumber/cucumber';
import { CustomWorld } from './world';
import * as fs from 'fs';
import * as path from 'path';
import { execSync, ChildProcess } from 'child_process';

setDefaultTimeout(30_000);

const SCREENSHOT_BASE_DIR = path.resolve(process.cwd(), 'docs', 'screenshots');
const GENERATE_SCREENSHOTS = process.env.GENERATE_SCREENSHOTS === 'true';
const WEB_URL = process.env.WEB_URL || 'http://localhost:3001';
const API_URL = process.env.API_URL || 'http://localhost:5001';

let aspireStarted = false;

async function isServerRunning(url: string): Promise<boolean> {
  try {
    await fetch(url);
    return true;
  } catch {
    return false;
  }
}

function isAspireRunning(): boolean {
  try {
    const output = execSync('aspire ps --format Json --nologo 2>/dev/null', { encoding: 'utf-8' });
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

BeforeAll(async function () {
  fs.mkdirSync(SCREENSHOT_BASE_DIR, { recursive: true });

  // Use Aspire to orchestrate all services (API + Web)
  if (!(await isServerRunning(`${API_URL}/health`))) {
    if (!isAspireRunning()) {
      console.log('Starting Aspire AppHost...');
      execSync('aspire start --nologo', {
        cwd: process.cwd(),
        stdio: 'inherit',
        timeout: 60000,
      });
      aspireStarted = true;
    }

    // Wait for API to be healthy
    console.log('Waiting for API to be healthy...');
    execSync('aspire wait api --status healthy --timeout 60 --nologo', {
      stdio: 'inherit',
      timeout: 70000,
    });

    // Wait for Web to be healthy when generating screenshots or running @ui tests
    if (GENERATE_SCREENSHOTS) {
      console.log('Waiting for Web to be healthy...');
      execSync('aspire wait web --status healthy --timeout 60 --nologo', {
        stdio: 'inherit',
        timeout: 70000,
      });
    }
  }
});

Before(async function (this: CustomWorld, { pickle, gherkinDocument }) {
  // Reset stores for test isolation
  try {
    await fetch(`${API_URL}/api/test/reset`, { method: 'POST' });
  } catch { /* server may not be ready yet */ }

  this.featureName = gherkinDocument?.feature?.name || 'unknown-feature';
  this.scenarioName = pickle.name || 'unknown-scenario';
  this.stepIndex = 0;

  // Open browser for @ui tagged scenarios, OR for all scenarios when generating screenshots
  const tags = pickle.tags?.map(t => t.name) || [];
  if (tags.includes('@ui') || GENERATE_SCREENSHOTS) {
    await this.openBrowser();
    // Navigate to the actual app so screenshots aren't blank
    if (this.page) {
      try {
        await this.page.goto(WEB_URL, { waitUntil: 'networkidle', timeout: 15000 });
      } catch {
        // App may not be fully loaded yet — still take screenshots
        try { await this.page.goto(WEB_URL, { waitUntil: 'domcontentloaded', timeout: 10000 }); } catch { /* best effort */ }
      }
    }
  }
});

AfterStep(async function (this: CustomWorld, { pickleStep, result }) {
  this.stepIndex++;
  if (this.page) {
    const stepText = pickleStep?.text || `step-${this.stepIndex}`;
    // Extract Gherkin keyword from the step text (Given/When/Then/And)
    const keyword = (pickleStep as any)?.keyword?.trim() ||
      (stepText.match(/^(Given|When|Then|And|But)\b/)?.[1] ?? 'Step');
    const status = result?.status?.toString() || 'PASSED';
    // Inject visual overlay showing current step context
    await this.injectStepOverlay(keyword, stepText, status);
    await this.takeStepScreenshot(stepText);
  }
});

After(async function (this: CustomWorld, { result }) {
  if (this.page) {
    // Only mark as failure for actually FAILED tests — not pending or skipped
    let status: string;
    switch (result?.status) {
      case 'PASSED':
        status = 'final';
        break;
      case 'FAILED':
        status = 'failure';
        break;
      case 'PENDING':
      case 'SKIPPED':
      case 'UNDEFINED':
        status = 'skipped';
        break;
      default:
        status = 'final';
    }
    const dir = this.screenshotDir;
    fs.mkdirSync(dir, { recursive: true });
    try {
      await this.page.screenshot({
        path: path.join(dir, `999-${status}.png`),
        fullPage: true,
      });
    } catch { /* Browser may already be closed */ }
  }
  await this.closeBrowser();
});

AfterAll(async function () {
  // Stop Aspire if we started it
  if (aspireStarted) {
    try { execSync('aspire stop --nologo', { stdio: 'inherit', timeout: 15000 }); } catch { /* already stopped */ }
    aspireStarted = false;
  }
});
