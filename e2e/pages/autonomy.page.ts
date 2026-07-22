import { expect, type Locator, type Page } from '@playwright/test';

export class AutonomyPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly repositoryInput: Locator;
  readonly branchInput: Locator;
  readonly metaAgentModelInput: Locator;
  readonly codingModelInput: Locator;
  readonly reviewModelInput: Locator;
  readonly maxTurnsInput: Locator;
  readonly maxMinutesInput: Locator;
  readonly maxCostInput: Locator;
  readonly createButton: Locator;
  readonly campaignList: Locator;
  readonly campaignDetail: Locator;
  readonly startButton: Locator;
  readonly pauseButton: Locator;
  readonly resumeButton: Locator;
  readonly stopButton: Locator;
  readonly errorAlert: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByTestId('autonomy-heading');
    this.repositoryInput = page.getByTestId('campaign-repository');
    this.branchInput = page.getByTestId('campaign-branch');
    this.metaAgentModelInput = page.getByTestId('campaign-meta-agent-model');
    this.codingModelInput = page.getByTestId('campaign-coding-model');
    this.reviewModelInput = page.getByTestId('campaign-review-model');
    this.maxTurnsInput = page.getByTestId('campaign-max-turns');
    this.maxMinutesInput = page.getByTestId('campaign-max-minutes');
    this.maxCostInput = page.getByTestId('campaign-max-cost');
    this.createButton = page.getByTestId('campaign-create');
    this.campaignList = page.getByTestId('campaign-list');
    this.campaignDetail = page.getByTestId('campaign-detail');
    this.startButton = page.getByTestId('campaign-start');
    this.pauseButton = page.getByTestId('campaign-pause');
    this.resumeButton = page.getByTestId('campaign-resume');
    this.stopButton = page.getByTestId('campaign-stop');
    this.errorAlert = page.getByTestId('autonomy-error');
  }

  async goto(): Promise<void> {
    const webUrl = process.env.WEB_URL;
    await this.page.goto(
      webUrl ? new URL('/autonomy', webUrl).toString() : '/autonomy',
    );
  }

  async createCampaign(input: {
    repository: string;
    branch: string;
    model: string;
    maxTurns?: number;
    maxMinutes?: number;
    maxCostUsd?: number;
  }): Promise<void> {
    await this.repositoryInput.fill(input.repository);
    await this.branchInput.fill(input.branch);
    await this.metaAgentModelInput.fill(input.model);
    await this.codingModelInput.fill(input.model);
    await this.reviewModelInput.fill(input.model);
    if (input.maxTurns !== undefined) {
      await this.maxTurnsInput.fill(String(input.maxTurns));
    }
    if (input.maxMinutes !== undefined) {
      await this.maxMinutesInput.fill(String(input.maxMinutes));
    }
    if (input.maxCostUsd !== undefined) {
      await this.maxCostInput.fill(String(input.maxCostUsd));
    }
    await this.createButton.click();
  }

  async openCampaign(repository: string): Promise<void> {
    await this.campaignList
      .getByRole('button', { name: repository })
      .first()
      .click();
  }

  async expectStatus(status: string): Promise<void> {
    await expect(this.campaignDetail.getByTestId('campaign-status')).toHaveText(status);
  }
}
