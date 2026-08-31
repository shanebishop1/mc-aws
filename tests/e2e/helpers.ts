import type { Page } from "@playwright/test";

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
  // Try multiple patterns: "Confirm", "Restore", "Hibernate", "Backup", etc.
  const confirmButton = page.getByRole("dialog").getByRole("button", {
    name: /confirm|restore|hibernate|start|stop|delete|backup/i,
  });

  // If there's a confirmation input, type the text
  if (typedConfirmation) {
    const input = page.getByRole("dialog").getByRole("textbox");
    await input.fill(typedConfirmation);
  }

  // Click confirm button
  await confirmButton.click();
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
 * Navigate to a specific page route
 * @param page - Playwright Page instance
 * @param path - The path to navigate to (e.g., "/dashboard")
 */
export async function navigateTo(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: "domcontentloaded" });
}
