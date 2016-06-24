/**
 * Copyright 2013-2015, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 */

'use strict';

module.exports = (file, api, options) => {
  const j = api.jscodeshift;

  require('./utils/array-polyfills');
  const ReactUtils = require('./utils/ReactUtils')(j);

  const printOptions =
    options.printOptions || {quote: 'single', trailingComma: true};
  const root = j(file.source);

  const AUTOBIND_IGNORE_KEYS = {
    componentDidMount: true,
    componentDidUpdate: true,
    componentWillReceiveProps: true,
    componentWillMount: true,
    componentWillUpdate: true,
    componentWillUnmount: true,
    getChildContext: true,
    getDefaultProps: true,
    getInitialState: true,
    render: true,
    shouldComponentUpdate: true,
  };

  const DEFAULT_PROPS_FIELD = 'getDefaultProps';
  const DEFAULT_PROPS_KEY = 'defaultProps';
  const GET_INITIAL_STATE_FIELD = 'getInitialState';

  const DEPRECATED_APIS = [
    'getDOMNode',
    'isMounted',
    'replaceProps',
    'replaceState',
    'setProps',
  ];

  const PURE_MIXIN_MODULE_NAME = options['mixin-module-name'] ||
    'react-addons-pure-render-mixin';

  const STATIC_KEY = 'statics';

  const STATIC_KEYS = {
    childContextTypes: true,
    contextTypes: true,
    displayName: true,
    propTypes: true,
  };

  const MIXIN_KEY = 'mixins';

  let shouldTransformFlow = false;

  if (options['flow']) {
    const programBodyNode = root.find(j.Program).get('body', 0).node;
    if (programBodyNode && programBodyNode.comments) {
      programBodyNode.comments.forEach(node => {
        if (node.value.indexOf('@flow') !== -1) {
          shouldTransformFlow = true;
        }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Checks if the module uses mixins or accesses deprecated APIs.
  const checkDeprecatedAPICalls = classPath =>
    DEPRECATED_APIS.reduce(
      (acc, name) =>
        acc + j(classPath)
          .find(j.Identifier, {name})
          .size(),
      0
    ) > 0;

  const hasNoCallsToDeprecatedAPIs = classPath => {
    if (checkDeprecatedAPICalls(classPath)) {
      console.warn(
        file.path + ': `' + ReactUtils.getComponentName(classPath) + '` ' +
        'was skipped because of deprecated API calls. Remove calls to ' +
        DEPRECATED_APIS.join(', ') + ' in your React component and re-run ' +
        'this script.'
      );
      return false;
    }
    return true;
  };

  const hasNoCallsToAPIsThatWillBeRemoved = classPath => {
    const hasInvalidCalls = (
      j(classPath).find(j.Identifier, {name: DEFAULT_PROPS_FIELD}).size() > 1 ||
      j(classPath).find(j.Identifier, {name: GET_INITIAL_STATE_FIELD}).size() > 1
    );
    if (hasInvalidCalls) {
      console.warn(
        file.path + ': `' + ReactUtils.getComponentName(classPath) + '` ' +
        'was skipped because of API calls that will be removed. Remove calls to `' +
        DEFAULT_PROPS_FIELD + '` and/or `' + GET_INITIAL_STATE_FIELD +
        '` in your React component and re-run this script.'
      );
      return false;
    }
    return true;
  };

  const doesNotUseArguments = classPath => {
    const hasArguments = (
      j(classPath).find(j.Identifier, {name: 'arguments'}).size() > 0
    );
    if (hasArguments) {
      console.warn(
        file.path + ': `' + ReactUtils.getComponentName(classPath) + '` ' +
        'was skipped because `arguments` was found in your functions. ' +
        'Arrow functions do not expose an `arguments` object; ' +
        'consider changing to use ES6 spread operator and re-run this script.'
      );
      return false;
    }
    return true;
  };

  const canConvertToClass = classPath => {
    const specPath = ReactUtils.getReactCreateClassSpec(classPath);
    const invalidProperties = specPath.properties.filter(prop => (
      !prop.key.name || (
        !STATIC_KEYS[prop.key.name] &&
        STATIC_KEY != prop.key.name &&
        !filterDefaultPropsField(prop) &&
        !filterGetInitialStateField(prop) &&
        !isFunctionExpression(prop) &&
        !isPrimProperty(prop) &&
        !isPrimPropertyWithTypeAnnotation(prop) &&
        MIXIN_KEY != prop.key.name
      )
    ));

    if (invalidProperties.length) {
      const invalidText = invalidProperties
        .map(prop => prop.key.name ? prop.key.name : prop.key)
        .join(', ');
      console.warn(
        file.path + ': `' + ReactUtils.getComponentName(classPath) + '` ' +
        'was skipped because of invalid field(s) `' + invalidText + '` on ' +
        'the React component. Remove any right-hand-side expressions that ' +
        'are not simple, like: `componentWillUpdate: createWillUpdate()` or ' +
        '`render: foo ? renderA : renderB`.'
      );
    }
    return !invalidProperties.length;
  };

  const areMixinsConvertible = (mixinIdentifierNames, classPath) => {
    if (
      ReactUtils.hasMixins(classPath) &&
      !ReactUtils.hasSpecificMixins(classPath, mixinIdentifierNames)
    ) {
      return false;
    }
    return true;
  };

  // ---------------------------------------------------------------------------
  // Helpers
  const createFindPropFn = prop => property => (
    property.key &&
    property.key.type === 'Identifier' &&
    property.key.name === prop
  );

  const filterDefaultPropsField = node =>
    createFindPropFn(DEFAULT_PROPS_FIELD)(node);

  const filterGetInitialStateField = node =>
    createFindPropFn(GET_INITIAL_STATE_FIELD)(node);

  const findGetInitialState = specPath =>
    specPath.properties.find(createFindPropFn(GET_INITIAL_STATE_FIELD));

  const withComments = (to, from) => {
    to.comments = from.comments;
    return to;
  };

  // ---------------------------------------------------------------------------
  // Collectors
  const isFunctionExpression = node => (
    node.key &&
    node.key.type === 'Identifier' &&
    node.value &&
    node.value.type === 'FunctionExpression'
  );

  const isPrimProperty = prop => (
    prop.key &&
    prop.key.type === 'Identifier' &&
    prop.value &&
    isPrimExpression(prop.value)
  );

  const isPrimPropertyWithTypeAnnotation = prop => (
    prop.key &&
    prop.key.type === 'Identifier' &&
    prop.value &&
    prop.value.type === 'TypeCastExpression' &&
    isPrimExpression(prop.value.expression)
  );

  const isPrimExpression = node => (
    node.type === 'Literal' || ( // NOTE this might change in babylon v6
      node.type === 'Identifier' &&
      node.name === 'undefined'
  ));

  // Collects `childContextTypes`, `contextTypes`, `displayName`, and `propTypes`;
  // simplifies `getDefaultProps` or converts it to an IIFE;
  // and collects everything else in the `statics` property object.
  const collectStatics = specPath => {
    const result = [];

    for (let i = 0; i < specPath.properties.length; i++) {
      const property = specPath.properties[i];
      if (createFindPropFn('statics')(property) && property.value && property.value.properties) {
        result.push(...property.value.properties);
      } else if (createFindPropFn(DEFAULT_PROPS_FIELD)(property)) {
        result.push(createDefaultProps(property));
      } else if (property.key && STATIC_KEYS[property.key.name]) {
        result.push(property);
      }
    }

    return result;
  };

  const collectProperties = specPath => specPath.properties
    .filter(prop =>
      !(filterDefaultPropsField(prop) || filterGetInitialStateField(prop))
    )
    .filter(prop =>
      isFunctionExpression(prop) ||
      isPrimPropertyWithTypeAnnotation(prop) ||
      isPrimProperty(prop)
    );

  const findRequirePathAndBinding = (moduleName) => {
    let result = null;

    const requireStatement = root.find(j.VariableDeclarator, {
      id: {type: 'Identifier'},
      init: {
        callee: {name: 'require'},
        arguments: [{value: moduleName}],
      },
    });

    const importStatement = root.find(j.ImportDeclaration, {
      source: {
        value: moduleName,
      },
    });

    if (importStatement.size()) {
      importStatement.forEach(path => {
        result = {
          path,
          binding: path.value.specifiers[0].id.name,
        };
      });
    } else if (requireStatement.size()) {
      requireStatement.forEach(path => {
        result = {
          path,
          binding: path.value.id.name,
        };
      });
    }

    return result;
  };

  const pureRenderMixinPathAndBinding = findRequirePathAndBinding(PURE_MIXIN_MODULE_NAME);

  // ---------------------------------------------------------------------------
  // Boom!
  const createMethodDefinition = fn =>
    withComments(j.methodDefinition(
      'method',
      fn.key,
      fn.value
    ), fn);

  const isInitialStateLiftable = getInitialState => {
    if (!getInitialState || !(getInitialState.value)) {
      return true;
    }

    return hasSingleReturnStatementWithObject(getInitialState.value);
  };

  const updatePropsAccess = getInitialState =>
    j(getInitialState)
      .find(j.MemberExpression, {
        object: {
          type: 'ThisExpression',
        },
        property: {
          type: 'Identifier',
          name: 'props',
        },
      })
      .forEach(path => j(path).replaceWith(j.identifier('props')));

  const inlineGetInitialState = getInitialState => {
    const functionExpressionAST = j(getInitialState.value);

    return functionExpressionAST
      .find(j.ReturnStatement)
      .forEach(path => {
        let shouldInsertReturnAfterAssignment = false;

        // if the return statement is not a direct child of the function body
        if (getInitialState.value.body.body.indexOf(path.value) === -1) {
          shouldInsertReturnAfterAssignment = true;
        }

        j(path).replaceWith(j.expressionStatement(
          j.assignmentExpression(
            '=',
            j.memberExpression(
              j.thisExpression(),
              j.identifier('state'),
              false
            ),
            path.value.argument
          )
        ));

        if (shouldInsertReturnAfterAssignment) {
          j(path).insertAfter(j.returnStatement(null));
        }
      }).getAST()[0].value.body.body;
  };

  const pickReturnValueOrCreateIIFE = value => {
    if (hasSingleReturnStatementWithObject(value)) {
      return value.body.body[0].argument;
    } else {
      return j.callExpression(
        value,
        []
      );
    }
  };

  const convertInitialStateToClassProperty = getInitialState =>
    withComments(j.classProperty(
      j.identifier('state'),
      pickReturnValueOrCreateIIFE(getInitialState.value),
      null,
      false
    ), getInitialState);

  const createConstructorArgs = (hasContextAccess) => {
    if (hasContextAccess) {
      return [j.identifier('props'), j.identifier('context')];
    }

    return [j.identifier('props')];
  };

  const createConstructor = (getInitialState) => {
    const initialStateAST = j(getInitialState);
    let hasContextAccess = false;

    if (
      initialStateAST.find(j.MemberExpression, { // has `this.context` access
        object: {type: 'ThisExpression'},
        property: {type: 'Identifier', name: 'context'},
      }).size() ||
      initialStateAST.find(j.CallExpression, { // a direct method call `this.x()`
        callee: {
          type: 'MemberExpression',
          object: {type: 'ThisExpression'},
        },
      }).size() ||
      initialStateAST.find(j.MemberExpression, { // `this` is referenced alone
        object: {type: 'ThisExpression'},
      }).size() !== initialStateAST.find(j.ThisExpression).size()
    ) {
      hasContextAccess = true;
    }

    updatePropsAccess(getInitialState);
    const constructorArgs = createConstructorArgs(hasContextAccess);

    return [
      createMethodDefinition({
        key: j.identifier('constructor'),
        value: j.functionExpression(
          null,
          constructorArgs,
          j.blockStatement(
            [].concat(
              [
                j.expressionStatement(
                  j.callExpression(
                    j.identifier('super'),
                    constructorArgs
                  )
                ),
              ],
              inlineGetInitialState(getInitialState)
            )
          )
        ),
      }),
    ];
  };

  const copyReturnType = (to, from) => {
    to.returnType = from.returnType;
    return to;
  };

  const createArrowFunctionExpression = fn =>
    copyReturnType(j.arrowFunctionExpression(
      fn.params,
      fn.body,
      false
    ), fn);

  const createArrowProperty = prop =>
    withComments(j.classProperty(
      j.identifier(prop.key.name),
      createArrowFunctionExpression(prop.value),
      null,
      false
    ), prop);

  const createClassProperty = prop =>
    withComments(j.classProperty(
      j.identifier(prop.key.name),
      prop.value,
      null,
      false
    ), prop);

  const createClassPropertyWithType = prop =>
    withComments(j.classProperty(
      j.identifier(prop.key.name),
      prop.value.expression,
      prop.value.typeAnnotation,
      false
    ), prop);

  // ---------------------------------------------------------------------------
  // Flow!

  const flowAnyType = j.anyTypeAnnotation();

  const literalToFlowType = node => {
    switch (typeof node.value) {
      case 'string':
        return j.stringLiteralTypeAnnotation(node.value, node.raw);
      case 'number':
        return j.numberLiteralTypeAnnotation(node.value, node.raw);
      case 'boolean':
        return j.booleanLiteralTypeAnnotation(node.value, node.raw);
      case 'object': // we already know it's a NullLiteral here
        return j.nullLiteralTypeAnnotation();
      default:
        return flowAnyType; // meh
    }
  };

  const propTypeToFlowMapping = {
    // prim types
    any: flowAnyType,
    array: j.genericTypeAnnotation(
      j.identifier('Array'),
      j.typeParameterInstantiation([flowAnyType])
    ),
    bool: j.booleanTypeAnnotation(),
    element: flowAnyType,
    func: j.genericTypeAnnotation(
      j.identifier('Function'),
      null
    ),
    node: flowAnyType,
    number: j.numberTypeAnnotation(),
    object: j.genericTypeAnnotation(
      j.identifier('Object'),
      null
    ),
    string: j.stringTypeAnnotation(),

    // type classes
    arrayOf: (type) => j.genericTypeAnnotation(
      j.identifier('Array'),
      j.typeParameterInstantiation([type])
    ),
    instanceOf: (type) => j.genericTypeAnnotation(
      type,
      null
    ),
    objectOf: (type) => j.objectTypeAnnotation([], [
      j.objectTypeIndexer(j.identifier('key'), j.stringTypeAnnotation(), type)
    ]),
    oneOf: (typeList) => j.unionTypeAnnotation(typeList),
    oneOfType: (typeList) => j.unionTypeAnnotation(typeList),
    shape: (propList) => j.objectTypeAnnotation(propList),
  };

  const propTypeToFlowAnnotation = val => {
    let cursor = val;
    let isOptional = true;
    let typeResult = flowAnyType;

    if ( // check `.isRequired` first
      cursor.type === 'MemberExpression' &&
      cursor.property.type === 'Identifier' &&
      cursor.property.name === 'isRequired'
    ) {
      isOptional = false;
      cursor = cursor.object;
    }

    if (cursor.type === 'CallExpression') { // type class
      const calleeName = cursor.callee.type === 'MemberExpression' ?
        cursor.callee.property.name :
        cursor.callee.name;

      const constructor = propTypeToFlowMapping[calleeName];
      if (!constructor) {
        typeResult = flowAnyType;
        return [typeResult, isOptional];
      }

      switch (cursor.callee.property.name) {
        case 'arrayOf': {
          const arg = cursor.arguments[0];
          typeResult = constructor(
            propTypeToFlowAnnotation(arg)[0]
          );
          break;
        }
        case 'instanceOf': {
          const arg = cursor.arguments[0];
          if (arg.type !== 'Identifier') {
            typeResult = flowAnyType;
            break;
          }

          typeResult = constructor(arg);
          break;
        }
        case 'objectOf': {
          const arg = cursor.arguments[0];
          typeResult = constructor(
            propTypeToFlowAnnotation(arg)[0]
          );
          break;
        }
        case 'oneOf': {
          const argList = cursor.arguments[0].elements;
          if (!argList.every(node => node.type === 'Literal')) {
            typeResult = flowAnyType;
          } else {
            typeResult = constructor(
              argList.map(literalToFlowType)
            );
          }
          break;
        }
        case 'oneOfType': {
          const argList = cursor.arguments[0].elements;
          typeResult = constructor(
            argList.map(arg => propTypeToFlowAnnotation(arg)[0])
          );
          break;
        }
        case 'shape': {
          const rawPropList = cursor.arguments[0].properties;
          const flowPropList = [];
          rawPropList.forEach(typeProp => {
            const name = typeProp.key.name;
            const [valueType, isOptional] = propTypeToFlowAnnotation(typeProp.value);
            flowPropList.push(j.objectTypeProperty(
              j.identifier(name),
              valueType,
              isOptional
            ));
          });

          typeResult = constructor(flowPropList);
          break;
        }
      }
    } else if ( // prim type
      cursor.type === 'MemberExpression' &&
      cursor.property.type === 'Identifier'
    ) {
      typeResult = propTypeToFlowMapping[cursor.property.name] || flowAnyType;
    }

    return [typeResult, isOptional];
  };

  const createFlowAnnotationsFromPropTypesProperties = (prop) => {
    const typePropertyList = [];

    if (!prop || prop.value.type !== 'ObjectExpression') {
      return typePropertyList;
    }

    prop.value.properties.forEach(typeProp => {
      if (!typeProp.key) { // SpreadProperty
        return;
      }

      const name = typeProp.key.name;
      const [valueType, isOptional] = propTypeToFlowAnnotation(typeProp.value);
      typePropertyList.push(j.objectTypeProperty(
        j.identifier(name),
        valueType,
        isOptional
      ));
    });

    return j.classProperty(
      j.identifier('props'),
      null,
      j.typeAnnotation(j.objectTypeAnnotation(typePropertyList)),
      false
    );
  };

  // to ensure that our property initializers' evaluation order is safe
  const repositionStateProperty = (initialStateProperty, propertiesAndMethods) => {
    if (j(initialStateProperty).find(j.ThisExpression).size() === 0) {
      return initialStateProperty.concat(propertiesAndMethods);
    }

    const result = [].concat(propertiesAndMethods);
    let lastPropPosition = result.length - 1;

    while (lastPropPosition >= 0 && result[lastPropPosition].kind === 'method') {
      lastPropPosition--;
    }

    result.splice(lastPropPosition + 1, 0, initialStateProperty[0]);
    return result;
  };

  // if there's no `getInitialState` or the `getInitialState` function is simple
  // (i.e., it's just a return statement) then we don't need a constructor.
  // we can simply lift `state = {...}` as a property initializer.
  // otherwise, create a constructor and inline `this.state = ...`.
  //
  // when we need to create a constructor, we only put `context` as the
  // second parameter when the following things happen in `getInitialState()`:
  // 1. there's a `this.context` access, or
  // 2. there's a direct method call `this.x()`, or
  // 3. `this` is referenced alone
  //
  // It creates a class with the following order of properties/methods:
  // 1. static properties
  // 2. constructor (if necessary)
  // 3. new properties (`state = {...};`)
  // 4. arrow functions
  // 5. other methods
  const createESClass = (
    name,
    baseClassName,
    staticProperties,
    getInitialState,
    rawProperties,
    comments
  ) => {
    let maybeConstructor = [];
    const initialStateProperty = [];

    if (isInitialStateLiftable(getInitialState)) {
      if (getInitialState) {
        initialStateProperty.push(convertInitialStateToClassProperty(getInitialState));
      }
    } else {
      maybeConstructor = createConstructor(getInitialState);
    }

    const propertiesAndMethods = rawProperties.map(prop => {
      if (isPrimPropertyWithTypeAnnotation(prop)) {
        return createClassPropertyWithType(prop);
      } else if (isPrimProperty(prop)) {
        return createClassProperty(prop);
      } else if (AUTOBIND_IGNORE_KEYS[prop.key.name]) {
        return createMethodDefinition(prop);
      }

      return createArrowProperty(prop);
    });

    const flowPropsAnnotation = shouldTransformFlow ?
      createFlowAnnotationsFromPropTypesProperties(
        staticProperties.find((path) => path.key.name === 'propTypes')
      ) :
      [];

    return withComments(j.classDeclaration(
      name ? j.identifier(name) : null,
      j.classBody(
        [].concat(
          flowPropsAnnotation,
          staticProperties,
          maybeConstructor,
          repositionStateProperty(initialStateProperty, propertiesAndMethods)
        )
      ),
      j.memberExpression(
        j.identifier('React'),
        j.identifier(baseClassName),
        false
      )
    ), {comments});
  };

  const createStaticClassProperty = staticProperty => {
    if (staticProperty.value.type === 'FunctionExpression') {
      return withComments(j.methodDefinition(
        'method',
        j.identifier(staticProperty.key.name),
        staticProperty.value,
        true
      ), staticProperty);
    }

    if (staticProperty.value.type === 'TypeCastExpression') {
      return withComments(j.classProperty(
        j.identifier(staticProperty.key.name),
        staticProperty.value.expression,
        staticProperty.value.typeAnnotation,
        true
      ), staticProperty);
    }

    return withComments(j.classProperty(
      j.identifier(staticProperty.key.name),
      staticProperty.value,
      null,
      true
    ), staticProperty);
  };

  const createStaticClassProperties = statics =>
    statics.map(createStaticClassProperty);

  const hasSingleReturnStatementWithObject = value => (
    value.type === 'FunctionExpression' &&
    value.body &&
    value.body.type === 'BlockStatement' &&
    value.body.body &&
    value.body.body.length === 1 &&
    value.body.body[0].type === 'ReturnStatement' &&
    value.body.body[0].argument &&
    value.body.body[0].argument.type === 'ObjectExpression'
  );

  const createDefaultProps = prop =>
    withComments(
      j.property(
        'init',
        j.identifier(DEFAULT_PROPS_KEY),
        pickReturnValueOrCreateIIFE(prop.value)
      ),
      prop
    );

  const getComments = classPath => {
    if (classPath.value.comments) {
      return classPath.value.comments;
    }
    const declaration = j(classPath).closest(j.VariableDeclaration);
    if (declaration.size()) {
      return declaration.get().value.comments;
    }
    return null;
  };

  const findUnusedVariables = (path, varName) => j(path)
    .closestScope()
    .find(j.Identifier, {name: varName})
    // Ignore require vars
    .filter(identifierPath => identifierPath.value !== path.value.id)
    // Ignore import bindings
    .filter(identifierPath => !(
      path.value.type === 'ImportDeclaration' &&
      path.value.specifiers.some(specifier => specifier.id === identifierPath.value)
    ))
    // Ignore properties in MemberExpressions
    .filter(identifierPath => {
      const parent = identifierPath.parent.value;
      return !(
        j.MemberExpression.check(parent) &&
        parent.property === identifierPath.value
      );
    });

  const updateToClass = (classPath, type) => {
    const specPath = ReactUtils.getReactCreateClassSpec(classPath);
    const name = ReactUtils.getComponentName(classPath);
    const statics = collectStatics(specPath);
    const properties = collectProperties(specPath);
    const comments = getComments(classPath);

    const getInitialState = findGetInitialState(specPath);

    var path;
    if (type == 'moduleExports' || type == 'exportDefault') {
      path = ReactUtils.findReactCreateClassCallExpression(classPath);
    } else {
      path = j(classPath).closest(j.VariableDeclaration);
    }

    const staticProperties = createStaticClassProperties(statics);
    const baseClassName =
      pureRenderMixinPathAndBinding &&
      ReactUtils.hasSpecificMixins(classPath, [pureRenderMixinPathAndBinding.binding]) ?
        'PureComponent' :
        'Component';

    path.replaceWith(
      createESClass(
        name,
        baseClassName,
        staticProperties,
        getInitialState,
        properties,
        comments
      )
    );
  };

  if (
    options['explicit-require'] === false || ReactUtils.hasReact(root)
  ) {
    // no mixins found on the classPath -> true
    // pure mixin identifier not found -> (has mixins) -> false
    // found pure mixin identifier ->
    //   class mixins is an array and only contains the identifier -> true
    //   otherwise -> false
    const mixinsFilter = (classPath) => {
      if (!ReactUtils.hasMixins(classPath)) {
        return true;
      } else if (pureRenderMixinPathAndBinding) {
        const {binding} = pureRenderMixinPathAndBinding;
        if (areMixinsConvertible([binding], classPath)) {
          return true;
        }
      }
      console.warn(
        file.path + ': `' + ReactUtils.getComponentName(classPath) + '` ' +
        'was skipped because of inconvertible mixins.'
      );
      return false;
    };

    const apply = (path, type) =>
      path
        .filter(mixinsFilter)
        .filter(hasNoCallsToDeprecatedAPIs)
        .filter(hasNoCallsToAPIsThatWillBeRemoved)
        .filter(doesNotUseArguments)
        .filter(canConvertToClass)
        .forEach(classPath => updateToClass(classPath, type));

    const didTransform = (
      apply(ReactUtils.findReactCreateClass(root), 'var')
        .size() +
      apply(ReactUtils.findReactCreateClassModuleExports(root), 'moduleExports')
        .size() +
      apply(ReactUtils.findReactCreateClassExportDefault(root), 'exportDefault')
        .size()
    ) > 0;

    if (didTransform) {
      // prune removed requires
      if (pureRenderMixinPathAndBinding) {
        const {binding, path} = pureRenderMixinPathAndBinding;
        if (findUnusedVariables(path, binding).size() === 0) {
          j(path).remove();
        }
      }

      return root.toSource(printOptions);
    }

  }

  return null;
};

module.exports.parser = 'flow';
