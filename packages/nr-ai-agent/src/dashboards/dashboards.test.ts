import fs from 'node:fs';
import path from 'node:path';

interface NrqlQuery {
  readonly query: string;
}

interface WidgetLayout {
  readonly column: number;
  readonly row: number;
  readonly width: number;
  readonly height: number;
}

interface Widget {
  readonly title: string;
  readonly layout: WidgetLayout;
  readonly visualization: { readonly id: string };
  readonly rawConfiguration: { readonly nrqlQueries: NrqlQuery[] };
}

interface DashboardPage {
  readonly name: string;
  readonly widgets: Widget[];
}

interface DashboardJson {
  readonly name: string;
  readonly description: string;
  readonly permissions: string;
  readonly pages: DashboardPage[];
}

describe('Dashboard JSON validation', () => {
  const dashboardsDir = path.join(__dirname, '../../dashboards');

  const dashboardFiles = ['ai-cost-explorer.json', 'ai-reliability.json'];

  dashboardFiles.forEach((fileName) => {
    describe(`${fileName}`, () => {
      let dashboardJson: DashboardJson;

      beforeAll(() => {
        const filePath = path.join(dashboardsDir, fileName);
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        dashboardJson = JSON.parse(fileContent);
      });

      it('should have valid JSON structure', () => {
        expect(dashboardJson).toBeDefined();
        expect(typeof dashboardJson).toBe('object');
      });

      it('should have required top-level fields', () => {
        expect(dashboardJson.name).toBeDefined();
        expect(typeof dashboardJson.name).toBe('string');
        expect(dashboardJson.name.length).toBeGreaterThan(0);

        expect(dashboardJson.description).toBeDefined();
        expect(typeof dashboardJson.description).toBe('string');

        expect(dashboardJson.permissions).toBeDefined();
        expect(dashboardJson.pages).toBeDefined();
        expect(Array.isArray(dashboardJson.pages)).toBe(true);
      });

      it('should have at least one page', () => {
        expect(dashboardJson.pages.length).toBeGreaterThan(0);
      });

      it('should have valid page structure', () => {
        dashboardJson.pages.forEach((page: DashboardPage) => {
          expect(page.name).toBeDefined();
          expect(typeof page.name).toBe('string');
          expect(page.name.length).toBeGreaterThan(0);

          expect(page.widgets).toBeDefined();
          expect(Array.isArray(page.widgets)).toBe(true);
          expect(page.widgets.length).toBeGreaterThan(0);
        });
      });

      it('should have valid widget structure', () => {
        dashboardJson.pages.forEach((page: DashboardPage) => {
          page.widgets.forEach((widget: Widget) => {
            expect(widget.title).toBeDefined();
            expect(typeof widget.title).toBe('string');
            expect(widget.title.length).toBeGreaterThan(0);

            expect(widget.layout).toBeDefined();
            expect(widget.layout.column).toBeDefined();
            expect(widget.layout.row).toBeDefined();
            expect(widget.layout.width).toBeDefined();
            expect(widget.layout.height).toBeDefined();

            expect(widget.visualization).toBeDefined();
            expect(widget.visualization.id).toBeDefined();
            expect(typeof widget.visualization.id).toBe('string');

            expect(widget.rawConfiguration).toBeDefined();
            expect(widget.rawConfiguration.nrqlQueries).toBeDefined();
            expect(Array.isArray(widget.rawConfiguration.nrqlQueries)).toBe(true);
            expect(widget.rawConfiguration.nrqlQueries.length).toBeGreaterThan(0);
          });
        });
      });

      it('should have valid NRQL queries', () => {
        const nrqlRegex = /^SELECT\s+/i;
        dashboardJson.pages.forEach((page: DashboardPage) => {
          page.widgets.forEach((widget: Widget) => {
            widget.rawConfiguration.nrqlQueries.forEach((nrqlQuery: NrqlQuery) => {
              expect(nrqlQuery.query).toBeDefined();
              expect(typeof nrqlQuery.query).toBe('string');
              expect(nrqlQuery.query.length).toBeGreaterThan(0);
              expect(nrqlRegex.test(nrqlQuery.query)).toBe(true);
              expect(nrqlQuery.query.toUpperCase().includes('FROM')).toBe(true);
            });
          });
        });
      });

      it('should have valid layout positions (no overlaps)', () => {
        dashboardJson.pages.forEach((page: DashboardPage) => {
          const usedPositions = new Set<string>();
          page.widgets.forEach((widget: Widget) => {
            const { column, row, width, height } = widget.layout;

            expect(column).toBeGreaterThanOrEqual(1);
            expect(row).toBeGreaterThanOrEqual(1);
            expect(width).toBeGreaterThanOrEqual(1);
            expect(height).toBeGreaterThanOrEqual(1);
            expect(column + width - 1).toBeLessThanOrEqual(12);

            for (let c = column; c < column + width; c++) {
              for (let r = row; r < row + height; r++) {
                const posKey = `${c},${r}`;
                expect(usedPositions.has(posKey)).toBe(false);
                usedPositions.add(posKey);
              }
            }
          });
        });
      });

      it('should reference valid event types', () => {
        const validEvents = ['AiResponse', 'AiRequest', 'AiConversationSummary'];
        dashboardJson.pages.forEach((page: DashboardPage) => {
          page.widgets.forEach((widget: Widget) => {
            widget.rawConfiguration.nrqlQueries.forEach((nrqlQuery: NrqlQuery) => {
              const query = nrqlQuery.query.toUpperCase();
              const hasValidEvent = validEvents.some((event) => query.includes(event.toUpperCase()));
              expect(hasValidEvent).toBe(true);
            });
          });
        });
      });
    });
  });
});
