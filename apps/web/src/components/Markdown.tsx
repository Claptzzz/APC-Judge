import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Enunciados y respuestas del asistente. `skipHtml` descarta el HTML crudo del Markdown
 * (react-markdown no usa `dangerouslySetInnerHTML`), y los links externos abren en otra pestaña.
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={className ?? 'prose-juez'}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children: linkChildren }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {linkChildren}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
