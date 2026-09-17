import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

// swc.vite() replaces esbuild's TS transform for this project specifically
// because esbuild does not implement emitDecoratorMetadata — NestJS's
// constructor-based dependency injection (every @Injectable()) relies on
// that metadata at runtime. SWC reads experimentalDecorators/
// emitDecoratorMetadata from tsconfig.json and emits it correctly.
export default defineConfig({
  plugins: [swc.vite()],
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.e2e-spec.ts', 'src/**/*.spec.ts'],
    testTimeout: 20000,
  },
});
