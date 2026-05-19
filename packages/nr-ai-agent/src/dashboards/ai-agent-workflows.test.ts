import { describe, it, expect } from '@jest/globals';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const dashboardConfig = require('../../dashboards/ai-agent-workflows.json');

describe('AI Agent Workflows Dashboard', () => {
  describe('dashboard structure', () => {
    it('has required top-level fields', () => {
      expect(dashboardConfig).toHaveProperty('name');
      expect(dashboardConfig).toHaveProperty('description');
      expect(dashboardConfig).toHaveProperty('pages');
    });

    it('has valid dashboard name', () => {
      expect(typeof dashboardConfig.name).toBe('string');
      expect(dashboardConfig.name.length).toBeGreaterThan(0);
    });

    it('has valid description', () => {
      expect(typeof dashboardConfig.description).toBe('string');
      expect(dashboardConfig.description.length).toBeGreaterThan(0);
    });

    it('has pages array with at least one page', () => {
      expect(Array.isArray(dashboardConfig.pages)).toBe(true);
      expect(dashboardConfig.pages.length).toBeGreaterThan(0);
    });
  });

  describe('page structure', () => {
    it('each page has a name and widgets', () => {
      dashboardConfig.pages.forEach((page: unknown) => {
        const p = page as Record<string, unknown>;
        expect(p).toHaveProperty('name');
        expect(p).toHaveProperty('widgets');
        expect(Array.isArray(p.widgets)).toBe(true);
      });
    });

    it('first page is "Overview"', () => {
      expect(dashboardConfig.pages[0].name).toBe('Overview');
    });

    it('has widgets array with expected count', () => {
      const firstPage = dashboardConfig.pages[0] as Record<string, unknown>;
      const widgets = firstPage.widgets as unknown[];
      expect(widgets.length).toBeGreaterThanOrEqual(15);
    });
  });

  describe('widget structure', () => {
    it('each widget has required fields', () => {
      const firstPage = dashboardConfig.pages[0] as Record<string, unknown>;
      const widgets = firstPage.widgets as unknown[];
      widgets.forEach((widget: unknown) => {
        const w = widget as Record<string, unknown>;
        expect(w).toHaveProperty('title');
        expect(w).toHaveProperty('layout');
        expect(w).toHaveProperty('rawConfiguration');
        expect(w).toHaveProperty('visualization');
      });
    });

    it('each widget has valid layout', () => {
      const firstPage = dashboardConfig.pages[0] as Record<string, unknown>;
      const widgets = firstPage.widgets as unknown[];
      widgets.forEach((widget: unknown) => {
        const w = widget as Record<string, unknown>;
        const layout = w.layout as Record<string, unknown>;
        expect(layout).toHaveProperty('column');
        expect(layout).toHaveProperty('row');
        expect(layout).toHaveProperty('width');
        expect(layout).toHaveProperty('height');
        expect(typeof layout.column).toBe('number');
        expect(typeof layout.row).toBe('number');
        expect(typeof layout.width).toBe('number');
        expect(typeof layout.height).toBe('number');
      });
    });

    it('each widget has visualization id', () => {
      const firstPage = dashboardConfig.pages[0] as Record<string, unknown>;
      const widgets = firstPage.widgets as unknown[];
      widgets.forEach((widget: unknown) => {
        const w = widget as Record<string, unknown>;
        const vis = w.visualization as Record<string, unknown>;
        expect(vis).toHaveProperty('id');
        expect(typeof vis.id).toBe('string');
      });
    });
  });

  describe('NRQL queries', () => {
    it('each widget has rawConfiguration with nrqlQueries', () => {
      const firstPage = dashboardConfig.pages[0] as Record<string, unknown>;
      const widgets = firstPage.widgets as unknown[];
      widgets.forEach((widget: unknown) => {
        const w = widget as Record<string, unknown>;
        const config = w.rawConfiguration as Record<string, unknown>;
        expect(config).toHaveProperty('nrqlQueries');
        expect(Array.isArray(config.nrqlQueries)).toBe(true);
      });
    });

    it('each query has accountId and query text', () => {
      const firstPage = dashboardConfig.pages[0] as Record<string, unknown>;
      const widgets = firstPage.widgets as unknown[];
      widgets.forEach((widget: unknown) => {
        const w = widget as Record<string, unknown>;
        const config = w.rawConfiguration as Record<string, unknown>;
        const queries = config.nrqlQueries as unknown[];
        queries.forEach((q: unknown) => {
          const query = q as Record<string, unknown>;
          expect(query).toHaveProperty('accountId');
          expect(query).toHaveProperty('query');
          const queryText = query.query as string;
          expect(typeof queryText).toBe('string');
          expect(queryText.length).toBeGreaterThan(0);
        });
      });
    });

    it('all queries are SELECT queries', () => {
      const firstPage = dashboardConfig.pages[0] as Record<string, unknown>;
      const widgets = firstPage.widgets as unknown[];
      widgets.forEach((widget: unknown) => {
        const w = widget as Record<string, unknown>;
        const config = w.rawConfiguration as Record<string, unknown>;
        const queries = config.nrqlQueries as unknown[];
        queries.forEach((q: unknown) => {
          const query = q as Record<string, unknown>;
          const queryText = query.query as string;
          expect(queryText.toUpperCase().startsWith('SELECT')).toBe(true);
        });
      });
    });

    it('key indicator widgets query AiAgentTaskSummary', () => {
      const firstPage = dashboardConfig.pages[0] as Record<string, unknown>;
      const widgets = firstPage.widgets as unknown[];
      const billboards = widgets.slice(0, 4) as unknown[];
      billboards.forEach((widget: unknown) => {
        const w = widget as Record<string, unknown>;
        const config = w.rawConfiguration as Record<string, unknown>;
        const queries = config.nrqlQueries as unknown[];
        const queryText = (queries[0] as Record<string, unknown>).query as string;
        expect(queryText.includes('AiAgentTaskSummary') || queryText.includes('AiAntiPattern')).toBe(true);
      });
    });

    it('anti-pattern queries reference AiAntiPattern event', () => {
      const firstPage = dashboardConfig.pages[0] as Record<string, unknown>;
      const widgets = firstPage.widgets as unknown[];
      const antiPatternWidgets = widgets.filter((w: unknown) => {
        const widget = w as Record<string, unknown>;
        const title = widget.title as string;
        return title.toLowerCase().includes('anti-pattern') || title.toLowerCase().includes('spinning wheels');
      });
      antiPatternWidgets.forEach((widget: unknown) => {
        const w = widget as Record<string, unknown>;
        const config = w.rawConfiguration as Record<string, unknown>;
        const queries = config.nrqlQueries as unknown[];
        const queryText = (queries[0] as Record<string, unknown>).query as string;
        expect(queryText.includes('AiAntiPattern')).toBe(true);
      });
    });

    it('tool usage queries reference Span events', () => {
      const firstPage = dashboardConfig.pages[0] as Record<string, unknown>;
      const widgets = firstPage.widgets as unknown[];
      const toolWidgets = widgets.filter((w: unknown) => {
        const widget = w as Record<string, unknown>;
        const title = widget.title as string;
        return title.toLowerCase().includes('tool');
      });
      toolWidgets.forEach((widget: unknown) => {
        const w = widget as Record<string, unknown>;
        const config = w.rawConfiguration as Record<string, unknown>;
        const queries = config.nrqlQueries as unknown[];
        const queryText = (queries[0] as Record<string, unknown>).query as string;
        expect(queryText.includes('Span')).toBe(true);
      });
    });
  });

  describe('key widgets', () => {
    it('has Task Completion Rate widget', () => {
      const firstPage = dashboardConfig.pages[0] as Record<string, unknown>;
      const widgets = firstPage.widgets as unknown[];
      const widget = widgets.find((w: unknown) => {
        const widget = w as Record<string, unknown>;
        return widget.title === 'Task Completion Rate';
      });
      expect(widget).toBeDefined();
    });

    it('has Average Cost per Task widget', () => {
      const firstPage = dashboardConfig.pages[0] as Record<string, unknown>;
      const widgets = firstPage.widgets as unknown[];
      const widget = widgets.find((w: unknown) => {
        const widget = w as Record<string, unknown>;
        return widget.title === 'Average Cost per Task';
      });
      expect(widget).toBeDefined();
    });

    it('has Anti-Pattern Detection Count widget', () => {
      const firstPage = dashboardConfig.pages[0] as Record<string, unknown>;
      const widgets = firstPage.widgets as unknown[];
      const widget = widgets.find((w: unknown) => {
        const widget = w as Record<string, unknown>;
        return widget.title === 'Anti-Pattern Detection Count';
      });
      expect(widget).toBeDefined();
    });

    it('has Delegation Depth Distribution widget', () => {
      const firstPage = dashboardConfig.pages[0] as Record<string, unknown>;
      const widgets = firstPage.widgets as unknown[];
      const widget = widgets.find((w: unknown) => {
        const widget = w as Record<string, unknown>;
        return widget.title === 'Delegation Depth Distribution';
      });
      expect(widget).toBeDefined();
    });

    it('has Context Resets widget', () => {
      const firstPage = dashboardConfig.pages[0] as Record<string, unknown>;
      const widgets = firstPage.widgets as unknown[];
      const widget = widgets.find((w: unknown) => {
        const widget = w as Record<string, unknown>;
        return (widget.title as string).includes('Context Resets');
      });
      expect(widget).toBeDefined();
    });
  });

  describe('visualization types', () => {
    it('uses valid New Relic visualization IDs', () => {
      const firstPage = dashboardConfig.pages[0] as Record<string, unknown>;
      const widgets = firstPage.widgets as unknown[];
      const validVisualizations = [
        'viz.billboard',
        'viz.line',
        'viz.bar',
        'viz.pie',
        'viz.table',
        'viz.histogram',
      ];
      widgets.forEach((widget: unknown) => {
        const w = widget as Record<string, unknown>;
        const vis = w.visualization as Record<string, unknown>;
        const vizId = vis.id as string;
        expect(validVisualizations.includes(vizId)).toBe(true);
      });
    });
  });

  describe('query content', () => {
    it('queries use SINCE or TIMESERIES time range', () => {
      const firstPage = dashboardConfig.pages[0] as Record<string, unknown>;
      const widgets = firstPage.widgets as unknown[];
      widgets.forEach((widget: unknown) => {
        const w = widget as Record<string, unknown>;
        const config = w.rawConfiguration as Record<string, unknown>;
        const queries = config.nrqlQueries as unknown[];
        queries.forEach((q: unknown) => {
          const query = q as Record<string, unknown>;
          const queryText = query.query as string;
          expect(
            queryText.includes('SINCE') || queryText.includes('TIMESERIES')
          ).toBe(true);
        });
      });
    });

    it('queries reference valid event types', () => {
      const firstPage = dashboardConfig.pages[0] as Record<string, unknown>;
      const widgets = firstPage.widgets as unknown[];
      const validEventTypes = [
        'AiAgentTaskSummary',
        'AiAntiPattern',
        'Span',
        'AiConversationSummary',
      ];
      widgets.forEach((widget: unknown) => {
        const w = widget as Record<string, unknown>;
        const config = w.rawConfiguration as Record<string, unknown>;
        const queries = config.nrqlQueries as unknown[];
        queries.forEach((q: unknown) => {
          const query = q as Record<string, unknown>;
          const queryText = query.query as string;
          const hasValidEvent = validEventTypes.some((eventType) =>
            queryText.includes(eventType)
          );
          expect(hasValidEvent).toBe(true);
        });
      });
    });
  });
});
