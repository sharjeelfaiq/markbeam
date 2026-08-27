export const DEFAULT_DOCUMENT = `# Welcome to Markbeam

Write Markdown on the left, watch it render on the right. Everything stays in your
browser — no account, no upload.

## Formatting

*Italic*, **bold**, _**both**_, \`inline code\`, and [links](https://markbeam.app).

## Lists

- Drag the beam in the middle to resize the panes
- Double-click it to snap back to centre
- Focus it and use the arrow keys if you prefer the keyboard

1. Press <kbd>Ctrl</kbd>+<kbd>K</kbd> for the command palette
2. Press <kbd>Ctrl</kbd>+<kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd> to switch views
3. Press <kbd>Ctrl</kbd>+<kbd>S</kbd> to export a PDF

## Quotes

> Markdown is a lightweight markup language with plain-text formatting syntax.
>
>> Nested quotes work too.

## Tables

| Feature          | Supported |
| ---------------- | :-------: |
| Mermaid diagrams |     ✓     |
| PDF export       |     ✓     |
| Dark mode        |     ✓     |

## Code

\`\`\`js
const beam = (source) => render(source);
beam('hello world');
\`\`\`

## Diagrams

\`\`\`mermaid
graph LR
  A[Write] --> B{Markbeam}
  B --> C[Preview]
  B --> D[PDF]
\`\`\`
`;
