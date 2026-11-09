// Vitest setup (happy-dom environment).
//
// happy-dom hardcodes `Node.prototype.nodeName` to "" and overrides it on
// `Element.prototype`. Browsers define the real getter on Node.prototype, and
// DOMPurify >= 3.4.15 reads names through that prototype getter as a DOM
// clobbering defence, so under happy-dom every element looks nameless and is
// stripped. Re-point the Node.prototype getter at the most specific
// implementation so DOMPurify sees the same names a browser would.
const nodeDesc = Object.getOwnPropertyDescriptor(Node.prototype, "nodeName");
if (nodeDesc?.get && nodeDesc.get.call(document.createElement("div")) === "") {
  const nodeGet = nodeDesc.get;
  Object.defineProperty(Node.prototype, "nodeName", {
    configurable: true,
    enumerable: nodeDesc.enumerable,
    get(this: Node) {
      // Most specific subclass getter wins (Element, Text, Comment, Document…).
      let proto = Object.getPrototypeOf(this);
      while (proto && proto !== Node.prototype) {
        const own = Object.getOwnPropertyDescriptor(proto, "nodeName");
        if (own?.get) return own.get.call(this);
        proto = Object.getPrototypeOf(proto);
      }
      return nodeGet.call(this);
    },
  });
}
