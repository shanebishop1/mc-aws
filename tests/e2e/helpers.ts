import type { Locator, Page } from "@playwright/test";

/**
 * Wait for page to fully load and be interactive
 * Waits for the page to be in a stable state with no network activity
 */
export async function waitForPageLoad(page: Page): Promise<void> {
  // Use domcontentloaded instead of networkidle to avoid timeouts
  await page.waitForLoadState("domcontentloaded");
}

/**
 * Confirm a dialog modal by typing the confirmation text and clicking confirm
 * @param page - Playwright Page instance
 * @param typedConfirmation - Optional text to type in confirmation input (e.g., server ID)
 */
export async function confirmDialog(page: Page, typedConfirmation?: string): Promise<void> {
  // Find the confirm button in the modal/dialog
  const confirmButton = page.getByRole("dialog").getByRole("button", { name: /confirm/i });

  // If there's a confirmation input, type the text
  if (typedConfirmation) {
    const input = page.getByRole("dialog").getByRole("textbox");
    await input.fill(typedConfirmation);
  }

  // Click confirm button
  await confirmButton.click();
}

/**
 * Cancel a dialog modal
 */
export async function cancelDialog(page: Page): Promise<void> {
  const cancelButton = page.getByRole("dialog").getByRole("button", { name: /cancel/i });
  await cancelButton.click();
}

/**
 * Expect an error message to be visible on the page
 * @param page - Playwright Page instance
 * @param message - The error message text or regex pattern to match
 */
export async function expectErrorMessage(page: Page, message: string | RegExp): Promise<void> {
  const errorElement = page.getByText(message);
  await errorElement.waitFor({ state: "visible" });
}

/**
 * Expect a success message to be visible on the page
 * @param page - Playwright Page instance
 * @param message - The success message text or regex pattern to match
 */
export async function expectSuccessMessage(page: Page, message: string | RegExp): Promise<void> {
  const successElement = page.getByText(message);
  await successElement.waitFor({ state: "visible" });
}

/**
 * Wait for a loading state to complete
 * @param page - Playwright Page instance
 * @param selector - Selector for the loading indicator (optional, defaults to common patterns)
 */
export async function waitForLoading(page: Page, selector?: string): Promise<void> {
  const loaderSelector = selector || '[aria-busy="true"], .loading, .spinner';

  try {
    await page.waitForSelector(loaderSelector, { state: "attached" });
    await page.waitForSelector(loaderSelector, { state: "detached" });
  } catch {
    // Loading might not have appeared, which is fine
  }
}

/**
 * Navigate to a specific page route
 * @param page - Playwright Page instance
 * @param path - The path to navigate to (e.g., "/dashboard")
 */
export async function navigateTo(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: "domcontentloaded" });
}

/**
 * Get the current server status from the UI
 * @param page - Playwright Page instance
 * @returns The server state text
 */
export async function getServerStatus(page: Page): Promise<string> {
  const statusElement = page.locator('[data-testid="server-status"]');
  return (await statusElement.textContent()) || "";
}

/**
 * Click a button by its text content
 * @param page - Playwright Page instance
 * @param text - The button text
 */
export async function clickButton(page: Page, text: string): Promise<void> {
  const button = page.getByRole("button", { name: text });
  await button.click();
}

/**
 * Fill a form field by its label
 * @param page - Playwright Page instance
 * @param label - The field label
 * @param value - The value to fill
 */
export async function fillByLabel(page: Page, label: string, value: string): Promise<void> {
  const input = page.getByLabel(label);
  await input.fill(value);
}

/**
 * Check if an element is visible
 * @param locator - Playwright Locator
 * @returns True if element is visible
 */
export async function isElementVisible(locator: Locator): Promise<boolean> {
  return locator.isVisible().catch(() => false);
}
