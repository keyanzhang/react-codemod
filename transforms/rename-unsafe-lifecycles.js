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

const DEPRECATED_APIS = Object.create(null);
DEPRECATED_APIS.componentWillMount = 'UNSAFE_componentWillMount';
DEPRECATED_APIS.componentWillReceiveProps = 'UNSAFE_componentWillReceiveProps';
DEPRECATED_APIS.componentWillUpdate = 'UNSAFE_componentWillUpdate';

export default (file, api, options) => {
  const j = api.jscodeshift;

  const printOptions = options.printOptions || {
    quote: 'single',
    trailingComma: true,
  };

  const root = j(file.source);

  let hasModifications = false;

  const renameDeprecatedApis = path => {
    const name = path.node.key.name;

    if (DEPRECATED_APIS[name]) {
      path.value.key.name = DEPRECATED_APIS[name];
      hasModifications = true;
    }
  };

  const renameDeprecatedCallExpressions = path => {
    if (!path.node.callee || !path.node.callee.property) {
      return;
    }

    const name = path.node.callee.property.name;

    if (DEPRECATED_APIS[name]) {
      path.node.callee.property.name = DEPRECATED_APIS[name];
      hasModifications = true;
    }
  };

  // Class methods
  root
    .find(j.MethodDefinition)
    .forEach(renameDeprecatedApis);

  // Arrow functions
  root
    .find(j.ClassProperty)
    .forEach(renameDeprecatedApis);

  // createReactClass and mixins
  root
    .find(j.Property)
    .forEach(renameDeprecatedApis);

  // Function calls
  root
    .find(j.CallExpression)
    .forEach(renameDeprecatedCallExpressions);

  return hasModifications
    ? root.toSource(printOptions)
    : null;
};
