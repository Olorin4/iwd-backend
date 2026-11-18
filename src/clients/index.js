// Public interface of the permanent Client module (design §2). Other modules,
// including interim billing in the future, import only from this file.
export {
    findOrCreateClientForTerms,
    getClient,
    setStripeCustomerId,
    setClientPaymentMethod,
    setClientKelevoRef,
    setClientStatus,
} from "./store.js";
