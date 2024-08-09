import { extname, dirname, parse as parseFilename } from 'path';
import { readFileSync } from 'fs';
import { parse } from '@babel/parser';
import { declare } from '@babel/helper-plugin-utils';
import resolve from 'resolve/sync';
import generate from '@babel/generator';

import optimize from './optimize';
import escapeBraces from './escapeBraces';
import transformSvg from './transformSvg';
import fileExistsWithCaseSync from './fileExistsWithCaseSync';
import { hyphenToCamel } from './camelize';

let ignoreRegex;

export default declare(({
  assertVersion,
  template,
  traverse,
  types: t,
}) => {
  assertVersion(7);

  const specialPattern = (name) => /^data-|^aria-/.test(name);

  const createObjectExpressions = (prop) => {
    const resultArray = prop.value.expression.properties.map((property) => {
      let value;

      if (/^\d*$/gi.test(property.value.value)) {
        value = t.numericLiteral(parseInt(property.value.value, 10));
      } else {
        value = t.stringLiteral(property.value.value);
      }

      return t.objectProperty(
        t.identifier(property.key.name),
        value,
      );
    });

    return t.objectExpression(resultArray);
  };

  const defaultValueTemplate = ({ name, identifier, defaultValue }) => {
    let variable;
    if (specialPattern(name)) {
      variable = t.objectProperty(
        t.stringLiteral(name),
        t.assignmentPattern(
          identifier,
          defaultValue,
        ),
        false,
        true, // shorthand
      );
    } else {
      variable = t.objectProperty(
        t.identifier(name),
        t.assignmentPattern(
          identifier,
          defaultValue,
        ),
        false,
        true, // shorthand
      );
    }

    return variable;
  };

  const buildSvg = ({
    IS_EXPORT,
    EXPORT_FILENAME,
    SVG_NAME,
    SVG_CODE: tempSvgCode,
  }) => {
    const SVG_CODE = tempSvgCode;
    const keepProps = [];
    const jsxKeepProps = [];

    const objectPattern = [];
    let jsxObjectPattern = [];

    SVG_CODE.openingElement.attributes.forEach((prop) => {
      if (prop.type === 'JSXSpreadAttribute') {
        keepProps.push(t.restElement(t.identifier(prop.argument.name)));
        jsxKeepProps.push(prop);
        return;
      }
      let defaultValue;

      if (prop.value.type === 'JSXExpressionContainer') {
        defaultValue = createObjectExpressions(prop);
      } else {
        defaultValue = prop.value;
      }

      objectPattern.push(defaultValueTemplate({
        name: prop.name.name.replace(/'/gi, ''),
        identifier: t.identifier(hyphenToCamel(prop.name.name).replace(/'/gi, '')),
        defaultValue,
      }));

      jsxObjectPattern.push(
        t.jsxAttribute(
          t.jsxIdentifier(prop.name.name),
          t.jsxExpressionContainer(t.identifier(hyphenToCamel(prop.name.name).replace(/'/gi, ''))),
        ),
      );
    });
    jsxObjectPattern = jsxObjectPattern.concat(jsxKeepProps);

    const blockStatement = t.blockStatement([
      t.returnStatement(t.identifier('SVG_CODE')),
    ]);
    const objectPatternList = objectPattern.concat(keepProps);
    const functionName = t.identifier('SVG_NAME');
    const namedFunctionDeclaration = t.functionDeclaration(
      functionName, // No name for the function (anonymous)
      [t.objectPattern(objectPatternList)],
      blockStatement,
    );

    const anonymousFunctionDeclaration = t.functionDeclaration(
      null, // No name for the function (anonymous)
      [t.objectPattern(objectPatternList)],
      blockStatement,
    );
    SVG_CODE.openingElement.attributes = jsxObjectPattern;

    const namedTemplate = `
      var SVG_NAME = ${generate(namedFunctionDeclaration, {
    jsescOption: {
      quotes: 'single',
    },
  }, '').code};
      ${IS_EXPORT ? 'export { SVG_NAME };' : ''}
    `;

    const anonymousTemplate = `
      var Component = ${generate(anonymousFunctionDeclaration, {
    jsescOption: {
      quotes: 'single',
    },
  }, '').code};
      Component.displayName = 'EXPORT_FILENAME';
      export default Component;
    `;

    if (SVG_NAME !== 'default') {
      return template(namedTemplate)({ SVG_NAME, SVG_CODE });
    }
    return template(anonymousTemplate)({ SVG_CODE, EXPORT_FILENAME });
  };

  function applyPlugin(importIdentifier, importPath, path, state, isExport, exportFilename) {
    if (typeof importPath !== 'string') {
      throw new TypeError('`applyPlugin` `importPath` must be a string');
    }
    const { ignorePattern, caseSensitive, filename: providedFilename } = state.opts;
    const { file, filename } = state;
    let newPath;
    if (ignorePattern) {
      // Only set the ignoreRegex once:
      ignoreRegex = ignoreRegex || new RegExp(ignorePattern);
      // Test if we should ignore this:
      if (ignoreRegex.test(importPath)) {
        return undefined;
      }
    }
    // This plugin only applies for SVGs:
    if (extname(importPath) === '.svg') {
      const iconPath = filename || providedFilename;
      const svgPath = resolve(importPath, {
        basedir: dirname(iconPath),
        preserveSymlinks: true,
      });
      if (caseSensitive && !fileExistsWithCaseSync(svgPath)) {
        throw new Error(`File path didn't match case of file on disk: ${svgPath}`);
      }
      if (!svgPath) {
        throw new Error(`File path does not exist: ${importPath}`);
      }
      const rawSource = readFileSync(svgPath, 'utf8');
      const optimizedSource = state.opts.svgo === false
        ? { data: rawSource }
        : optimize(rawSource, { ...state.opts.svgo, path: svgPath });

      const escapeSvgSource = escapeBraces(optimizedSource);

      const parsedSvgAst = parse(escapeSvgSource.data, {
        sourceType: 'module',
        plugins: ['jsx'],
      });

      traverse(parsedSvgAst, transformSvg(t));

      const svgCode = traverse.removeProperties(parsedSvgAst.program.body[0].expression);
      const opts = {
        SVG_NAME: importIdentifier,
        SVG_CODE: svgCode,
        IS_EXPORT: isExport,
        EXPORT_FILENAME: exportFilename,
      };

      const svgReplacement = buildSvg(opts);
      if (Array.isArray(svgReplacement)) {
        [newPath] = path.replaceWithMultiple(svgReplacement);
      } else {
        newPath = path.replaceWith(svgReplacement);
      }

      file.get('ensureReact')();
      file.set('ensureReact', () => {});
    }
    return newPath;
  }

  return {
    visitor: {
      Program: {
        enter(path, { file, opts, filename }) {
          if (typeof filename === 'string' && typeof opts.filename !== 'undefined') {
            throw new TypeError('the "filename" option may only be provided when transforming code');
          }
          if (typeof filename === 'undefined' && typeof opts.filename !== 'string') {
            throw new TypeError('the "filename" option is required when transforming code');
          }
          if (!path.scope.hasBinding('React')) {
            const reactImportDeclaration = t.importDeclaration([
              t.importDefaultSpecifier(t.identifier('React')),
            ], t.stringLiteral('react'));

            file.set('ensureReact', () => {
              const [newPath] = path.unshiftContainer('body', reactImportDeclaration);
              newPath.get('specifiers').forEach((specifier) => { path.scope.registerBinding('module', specifier); });
            });
          } else {
            file.set('ensureReact', () => {});
          }
        },
      },
      CallExpression(path, state) {
        const { node } = path;
        const requireArg = node.arguments.length > 0 ? node.arguments[0] : null;
        const filePath = t.isStringLiteral(requireArg) ? requireArg.value : null;
        if (node.callee.name === 'require' && t.isVariableDeclarator(path.parent) && filePath) {
          applyPlugin(path.parent.id, filePath, path.parentPath.parentPath, state);
        }
      },
      ImportDeclaration(path, state) {
        const { node } = path;
        if (node.specifiers.length > 0) {
          applyPlugin(node.specifiers[0].local, node.source.value, path, state);
        }
      },
      ExportNamedDeclaration(path, state) {
        const { node, scope } = path;
        if (node.specifiers.length > 0 && node.specifiers[0].local && node.specifiers[0].local.name === 'default') {
          const exportName = node.specifiers[0].exported.name;
          const filename = parseFilename(node.source.value).name;
          const newPath = applyPlugin(exportName, node.source.value, path, state, true, filename);
          if (newPath) {
            scope.registerDeclaration(newPath);
          }
        }
      },
    },
  };
});
