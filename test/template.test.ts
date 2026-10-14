import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  getInitials,
  getSiteLabel,
  getWordCount,
  renderTemplate,
  stripConditionalBlocks,
} from '../lambda/lib/template';

describe('escapeHtml', () => {
  it('escapa los caracteres especiales de HTML', () => {
    expect(escapeHtml(`<script>alert("x" & 'y')</script>`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot; &amp; &#39;y&#39;)&lt;/script&gt;'
    );
  });
});

describe('helpers de texto', () => {
  it('cuenta palabras ignorando espacios extra', () => {
    expect(getWordCount('  hola   mundo \n bonito ')).toBe(3);
    expect(getWordCount('   ')).toBe(0);
  });

  it('saca las iniciales en mayúsculas', () => {
    expect(getInitials(' mario  gutiérrez ')).toBe('MG');
  });
});

describe('getSiteLabel', () => {
  it('usa la etiqueta corta de los sitios conocidos', () => {
    expect(getSiteLabel('https://mario-gutierrez.com')).toBe('resume');
    expect(getSiteLabel('https://www.mario-gutierrez.com')).toBe('resume');
    expect(getSiteLabel('https://portfolio.mario-gutierrez.com')).toBe('portfolio');
  });

  it('cae al hostname o a "unknown"', () => {
    expect(getSiteLabel('https://otro.com')).toBe('otro.com');
    expect(getSiteLabel('')).toBe('unknown');
  });
});

describe('template', () => {
  const template = 'Hola {{name}}<!--IF:phone--> · tel {{phone}}<!--ENDIF:phone--><!--IF:user_subject--> · {{user_subject}}<!--ENDIF:user_subject--> · {{name}}';

  it('quita los bloques opcionales que no vienen', () => {
    expect(stripConditionalBlocks(template, new Set(['phone']))).toBe(
      'Hola {{name}} · tel {{phone}} · {{name}}'
    );
  });

  it('reemplaza todas las apariciones de cada variable', () => {
    expect(renderTemplate(template, { name: 'Ada', phone: '555' }, new Set(['phone']))).toBe(
      'Hola Ada · tel 555 · Ada'
    );
  });
});
