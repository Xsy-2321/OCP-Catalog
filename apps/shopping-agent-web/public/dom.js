/** @param {string} id @returns {HTMLElement} */
export function getElement(id) {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) throw new Error(`Missing page element: ${id}`);
  return element;
}

/** @param {string} id @returns {HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement} */
export function getControl(id) {
  const element = getElement(id);
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
    || element instanceof HTMLSelectElement || element instanceof HTMLButtonElement)) throw new Error(`Invalid control: ${id}`);
  return element;
}

/** @param {string} id @returns {HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement} */
export function getField(id) {
  const element = getControl(id);
  if (element instanceof HTMLButtonElement) throw new Error(`Invalid field: ${id}`);
  return element;
}

/** @param {string} id @returns {HTMLInputElement} */
export function getInput(id) {
  const element = getElement(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`Invalid input: ${id}`);
  return element;
}

/** @param {string} id @returns {HTMLDialogElement} */
export function getDialog(id) {
  const element = getElement(id);
  if (!(element instanceof HTMLDialogElement)) throw new Error(`Invalid dialog: ${id}`);
  return element;
}

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {string | undefined} [text]
 * @param {string} [className]
 * @returns {HTMLElementTagNameMap[K]}
 */
export function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
