import { expect, test, type Page } from '@playwright/test'

const SHORTCUT_MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

async function openApp(page: Page) {
  await page.goto('/?e2e=1')
  await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible()
}

async function openExecutionPlanFromKeywordSearch(page: Page) {
  await page.keyboard.press(`${SHORTCUT_MOD}+Shift+F`)
  const input = page.getByPlaceholder('Search notes by keyword...')
  await expect(input).toBeVisible()
  await input.fill('execution plan')
  await expect(page.getByText('Execution Plan').first()).toBeVisible()
  await input.press('Enter')
  await expect(input).not.toBeVisible()
  await expect(page.locator('textarea[placeholder="Start writing..."]')).toHaveValue(/#\s*Execution Plan/i)
}

test('app loads and opens a note from keyword search', async ({ page }) => {
  await openApp(page)
  await openExecutionPlanFromKeywordSearch(page)
  const editor = page.locator('textarea[placeholder="Start writing..."]')
  await expect(editor).toBeVisible()
  await expect(editor).toHaveValue(/MVP Goals/)
})

test('global keyword search highlights matches and opens selected result', async ({ page }) => {
  await openApp(page)
  await page.keyboard.press(`${SHORTCUT_MOD}+Shift+F`)

  const input = page.getByPlaceholder('Search notes by keyword...')
  await input.fill('prompt')

  await expect(page.locator('mark').first()).toBeVisible()
  await input.press('Enter')

  await expect(input).not.toBeVisible()
  await expect(page.locator('textarea[placeholder="Start writing..."]')).toHaveValue(/#\s*Prompt Generation Template/i)
})

test('find in current file keeps focus and cycles results on Enter', async ({ page }) => {
  await openApp(page)
  await openExecutionPlanFromKeywordSearch(page)

  await page.keyboard.press(`${SHORTCUT_MOD}+F`)
  const findInput = page.getByPlaceholder('Find in current file...')
  await expect(findInput).toBeVisible()
  await expect(findInput).toBeFocused()

  await findInput.fill('plan')
  await expect(findInput).toBeFocused()

  await findInput.press('Enter')
  await expect(findInput).toBeFocused()

  const selectionLength = await page
    .locator('textarea[placeholder="Start writing..."]')
    .evaluate((el) => {
      const area = el as HTMLTextAreaElement
      return area.selectionEnd - area.selectionStart
    })
  expect(selectionLength).toBeGreaterThan(0)

  await expect(page.getByText(/\d+\s*\/\s*\d+/)).toBeVisible()
})

test('qa answers from notes and source click opens the note', async ({ page }) => {
  await openApp(page)

  await page.getByTitle('Toggle Q&A Panel').click()
  const qaInput = page.getByPlaceholder('Ask a question...')
  await expect(qaInput).toBeVisible()

  await qaInput.fill('what is my execution plan for ai knowledge base')
  await qaInput.press('Enter')

  await expect(page.getByText('Answer 1')).toBeVisible()
  const sourceButton = page.getByRole('button', { name: /Source:/ }).first()
  await expect(sourceButton).toBeVisible()
  await sourceButton.click()

  await expect(page.locator('textarea[placeholder="Start writing..."]')).toHaveValue(/#\s*Execution Plan/i)
  await expect(page.getByText('Failed to open file')).not.toBeVisible()
})

test('new note autosaves while typing and updates saved status', async ({ page }) => {
  await openApp(page)

  await page.getByRole('button', { name: 'New Note' }).click()
  const editor = page.locator('textarea[placeholder="Start writing..."]')
  await expect(editor).toBeVisible()

  await editor.fill('I built APIs with OpenAPI, JWT auth, monitoring, and CI CD hardening.')
  await expect(page.getByText('Unsaved changes').first()).toBeVisible()
  await page.keyboard.press(`${SHORTCUT_MOD}+S`)
  await expect(page.getByText('Saved in vault').first()).toBeVisible({ timeout: 12_000 })
  await expect(page.getByText('Work / Engineering')).toBeVisible()
})

test('preview block quick actions duplicate block content', async ({ page }) => {
  await openApp(page)
  await openExecutionPlanFromKeywordSearch(page)

  await page.getByRole('button', { name: 'Preview' }).click()
  const mvpHeading = page.getByRole('heading', { name: 'MVP Goals' })
  await expect(mvpHeading).toBeVisible()
  const mvpGroup = mvpHeading.locator('xpath=ancestor::div[contains(@class,"group")][1]')
  await mvpGroup.hover()
  const duplicateButton = mvpGroup.locator('button[title="Duplicate block"]')
  await expect(duplicateButton).toBeVisible()
  await duplicateButton.click()

  await page.getByRole('button', { name: 'Edit' }).click()
  const editorValue = await page.locator('textarea[placeholder="Start writing..."]').inputValue()
  const occurrences = (editorValue.match(/## MVP Goals/g) || []).length
  expect(occurrences).toBeGreaterThan(1)
})
