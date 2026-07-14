import { type Locator, type Page } from '@playwright/test';

export class DevEnvironmentsPage {
  readonly page: Page;
  readonly cardsViewButton: Locator;
  readonly listViewButton: Locator;
  readonly list: Locator;
  readonly selectAllCheckbox: Locator;
  readonly bulkDeleteButton: Locator;
  readonly bulkResult: Locator;

  constructor(page: Page) {
    this.page = page;
    this.cardsViewButton = page.getByTestId('dev-env-view-cards');
    this.listViewButton = page.getByTestId('dev-env-view-list');
    this.list = page.getByTestId('dev-env-list');
    this.selectAllCheckbox = page.getByTestId('dev-env-select-all');
    this.bulkDeleteButton = page.getByTestId('dev-env-bulk-delete');
    this.bulkResult = page.getByTestId('dev-env-bulk-result');
  }

  async goto(): Promise<void> {
    await this.page.goto('/dev-environments');
  }

  environmentRow(title: string): Locator {
    return this.list.getByRole('row', { name: new RegExp(title) });
  }

  environmentCheckbox(title: string): Locator {
    return this.page.getByRole('checkbox', { name: `Select ${title}` });
  }

  async showList(): Promise<void> {
    await this.listViewButton.click();
  }

  async selectEnvironment(title: string): Promise<void> {
    await this.environmentCheckbox(title).check();
  }

  async deleteSelected(): Promise<void> {
    await this.bulkDeleteButton.click();
  }
}
