/**
 * @license
 * Copyright (c) 2017 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at
 * http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at
 * http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 */

// The first argument to JS template tags retain identity across multiple
// calls to a tag for the same literal, so we can cache work done per literal
// in a Map.
const templates = new Map<TemplateStringsArray, Template>();

/**
 * Interprets a template literal as an HTML template that can efficiently
 * render to and update a container.
 */
export function html(strings: TemplateStringsArray, ...values: any[]): TemplateResult {
  let template = templates.get(strings);
  if (template === undefined) {
    template = new Template(strings);
    templates.set(strings, template);
  }
  return new TemplateResult(template, values);
}

/**
 * The return type of `html`, which holds a Template and the values from
 * interpolated expressions.
 */
export class TemplateResult {
  template: Template;
  values: any[];

  constructor(template: Template, values: any[]) {
    this.template = template;
    this.values = values;
  }

  /**
   * Renders this template to a container. To update a container with new values,
   * reevaluate the template literal and call `renderTo` of the new result.
   */
  renderTo(container: Element|DocumentFragment) {
    let instance = container.__templateInstance as TemplateInstance;
    if (instance === undefined) {
      instance = new TemplateInstance(this.template);
      container.__templateInstance = instance;
      const fragment = instance._clone();
      instance.update(this.values);
      container.appendChild(fragment);
    } else {
      instance.update(this.values);
    }
  }

}

const exprMarker = '{{}}';

/**
 * A placeholder for a dynamic expression in an HTML template.
 * 
 * There are two built-in part types: AttributePart and NodePart. NodeParts
 * always represent a single dynamic expression, while AttributeParts may
 * represent as many expressions are contained in the attribute.
 * 
 * A Template's parts are mutable, so parts can be replaced or modified
 * (possibly to implement different template semantics). The contract is that
 * parts can only be replaced, not removed, added or reordered, and parts must
 * always consume the correct number of values in their `update()` method.
 * 
 * TODO(justinfagnani): That requirement is a little fragile. A
 * TemplateInstance could instead be more careful about which values it gives
 * to Part.update().
 */
export class TemplatePart {
  constructor(
    public type: string,
    public index: number,
    public name?: string,
    public rawName?: string,
    public strings?: string[]) {
  }
}

export class Template {
  private _strings: TemplateStringsArray;
  parts: TemplatePart[] = [];
  element: HTMLTemplateElement;

  constructor(strings: TemplateStringsArray) {
    this._strings = strings;
    this._parse();
  }

  private _parse() {
    this.element = document.createElement('template');
    this.element.innerHTML = this._getTemplateHtml(this._strings);
    const walker = document.createTreeWalker(this.element.content,
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let index = -1;
    let partIndex = 0;
    const nodesToRemove = [];
    const attributesToRemove = [];
    while (walker.nextNode()) {
      index++;
      const node = walker.currentNode;
      if (node.nodeType === Node.ELEMENT_NODE) {
        const attributes = node.attributes;
        for (let i = 0; i < attributes.length; i++) {
          const attribute = attributes.item(i);
          const value = attribute.value;
          const strings = value.split(exprMarker);
          if (strings.length > 1) {
            const attributeString = this._strings[partIndex];
            partIndex += strings.length - 1;
            const match = attributeString.match(/((?:\w|[.\-_])+)=?("|')?$/);
            const rawName = match![1];
            this.parts.push(new TemplatePart('attribute', index, attribute.name, rawName, strings));
            attributesToRemove.push(attribute);
          }
        }
      } else if (node.nodeType === Node.TEXT_NODE) {
        const strings = node.nodeValue!.split(exprMarker);
        if (strings.length > 1) {
          // Generate a new text node for each literal and two for each part,
          // a start and end
          partIndex += strings.length - 1;
          for (let i = 0; i < strings.length; i++) {
            const string = strings[i];
            const literalNode = new Text(string);
            node.parentNode!.insertBefore(literalNode, node);
            index++;
            if (i < strings.length - 1) {
              node.parentNode!.insertBefore(new Text(), node);
              node.parentNode!.insertBefore(new Text(), node);
              this.parts.push(new TemplatePart('node', index));
              index++;
            }
          }
          nodesToRemove.push(node);
          index--;
        }
      }
    }
    // Remove text binding nodes after the walk to not disturb the TreeWalker
    for (const n of nodesToRemove) {
      n.parentNode!.removeChild(n);
    }
    for (const a of attributesToRemove) {
      a.ownerElement.removeAttribute(a.name);
    }
  }

  private _getTemplateHtml(strings: TemplateStringsArray): string {
    const parts = [];
    for (let i = 0; i < strings.length; i++) {
      parts.push(strings[i]);
      if (i < strings.length - 1) {
        parts.push(exprMarker);
      }
    }
    return parts.join('');
  }

}

export abstract class Part {
  abstract setValue(value: any): void;

  protected _getValue(value: any) {
  while (typeof value === 'function') {
    try {
      value = value(this);
    } catch (e) {
      console.error(e);
      return;
    }
  }
  if (value === null) {
    return undefined;
  }
  return value;
}
}

export class AttributePart extends Part {
  element: Element;
  name: string;
  rawName: string;
  strings: string[];

  constructor(element: Element, name: string, rawName: string, strings: string[]) {
    super();
    console.assert(element.nodeType === Node.ELEMENT_NODE);
    this.element = element;
    this.name = name;
    this.rawName = rawName;
    this.strings = strings;
  }

  setValue(values: any[]): void {
    const strings = this.strings;
    let text = '';

    for (let i = 0; i < strings.length; i++) {
      text += strings[i];
      if (i < strings.length - 1) {
        const v = this._getValue(values[i]);
        if (v && typeof v !== 'string' && v[Symbol.iterator]) {
          for (const t of v) {
            // TODO: we need to recursively call getValue into iterables...
            text += t;
          }
        } else {
          text += v;
        }
      }
    }
    this.element.setAttribute(this.name, text);
  }
  
}

export class NodePart extends Part {
  startNode: Node;
  endNode: Node;
  private _previousValue: any;

  constructor(startNode: Node, endNode: Node) {
    super();
    this.startNode = startNode;
    this.endNode = endNode;
  }

  setValue(value: any): void {

    let node: Node|undefined = undefined;
    value = this._getValue(value);

    if (value instanceof Node) {
      this.clear();
      node = value;
    } else if (value instanceof TemplateResult) {
      let instance: TemplateInstance;
      if (this._previousValue && this._previousValue._template === value.template) {
        instance = this._previousValue;
      } else {
        this.clear();
        instance = new TemplateInstance(value.template);
        node = instance._clone();
      }
      instance.update(value.values);
      this._previousValue = instance;
    } else if (value && typeof value !== 'string' && value[Symbol.iterator]) {
      // For an Iterable, we create a new InstancePart per item, then set its
      // value to the item. This is a little bit of overhead for every item in
      // an Iterable, but it lets us recurse easily and update Arrays of
      // TemplateResults that will be commonly returned from expressions like:
      // array.map((i) => html`${i}`)

      // We reuse this parts startNode as the first part's startNode, and this
      // parts endNode as the last part's endNode.

      let itemStart = this.startNode;
      let itemEnd;
      const values = value[Symbol.iterator]() as Iterator<any>;

      const previousParts = Array.isArray(this._previousValue) ? this._previousValue : undefined;
      let previousPartsIndex = 0;
      const itemParts = [];
      let current = values.next();
      let next = values.next();

      while (!current.done) {
        if (next.done) {
          // on the last item, reuse this part's endNode
          itemEnd = this.endNode;
        } else {
          itemEnd = new Text();
          this.endNode.parentNode!.insertBefore(itemEnd, this.endNode);
        }

        // Reuse a part if we can, otherwise create a new one
        let itemPart;
        if (previousParts !== undefined && previousPartsIndex < previousParts.length) {
          itemPart = previousParts[previousPartsIndex++];
        } else {
          itemPart = new NodePart(itemStart, itemEnd);
        }

        itemPart.setValue(current.value);
        itemParts.push(itemPart);

        current = next;
        next = values.next();
        itemStart = itemEnd;
      }
      this._previousValue = itemParts;

      // If the new list is shorter than the old list, clean up:
      if (previousParts !== undefined && previousPartsIndex < previousParts.length) {
        const clearStart = previousParts[previousPartsIndex].startNode;
        const clearEnd = previousParts[previousParts.length - 1].endNode;
        const clearRange = document.createRange();
        if (previousPartsIndex === 0) {
          clearRange.setStartBefore(clearStart);  
        } else {
          clearRange.setStartAfter(clearStart);
        }
        clearRange.setEndAfter(clearEnd);
        clearRange.deleteContents();
        clearRange.detach(); // is this neccessary?
      }

    } else {
      this.clear();
      node = new Text(value);
    }
    if (node !== undefined) {
      this.endNode.parentNode!.insertBefore(node, this.endNode);
    }
  }

  clear() {
    this._previousValue = undefined;
    let node: Node = this.startNode;
    let next: Node|null = node.nextSibling;
    while (next !== null && next !== this.endNode) {
      node = next;
      next = next.nextSibling;
      node.parentNode!.removeChild(node);
    }
  }

  // detach(): DocumentFragment ?
}

export class TemplateInstance {
  _template: Template;
  _parts: Part[] = [];
  startNode: Node;
  endNode: Node;

  constructor(template: Template) {
    this._template = template;
  }

  update(values: any[]) {
    let valueIndex = 0;
    for (const part of this._parts) {
      if (part instanceof NodePart) {
        part.setValue(values[valueIndex++]);
      } else if (part instanceof AttributePart) {
        const size = part.strings.length - 1;
        part.setValue(values.slice(valueIndex, size));
        valueIndex += size;
      }
    }
  }

  _clone(): DocumentFragment {
    const fragment = document.importNode(this._template.element.content, true);

    if (this._template.parts.length > 0) {
      const walker = document.createTreeWalker(fragment,
          NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);

      const parts = this._template.parts;
      let index = -1;
      let partIndex = 0;
      let templatePart = parts[0];
      
      while (walker.nextNode() && partIndex < parts.length) {
        index++;
        if (index === templatePart.index) {
          const node = walker.currentNode;
          this._parts.push(this._createPart(templatePart, node));
          templatePart = parts[++partIndex];
        }
      }
    }
    return fragment;
  }

  _createPart(templatePart: TemplatePart, node: Node): Part {
    if (templatePart.type === 'attribute') {
      return new AttributePart(node as Element, templatePart.name!, templatePart.rawName!, templatePart.strings!);
    } else if (templatePart.type === 'node') {
      return new NodePart(node, node.nextSibling!);
    } else {
      throw new Error(`unknown part type: ${templatePart.type}`);
    }
  }

}

declare global {
  interface Node {
    __templateInstance?: {
      startNode: Node;
      endNode: Node;
    };
    __startMarker?: Node;
  }
}
