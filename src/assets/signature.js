// src/assets/signature.js
//
// The same signature as the "Iron Wing" signature in Zoho Mail, which Zoho
// adds only to mail written in Zoho itself. Copied from a Zoho email on
// 2026-11-17. The logo is attached to each email (cid:companyLogo) so mail
// programs that block web images still show it.

const signature = `
    <div style="font-family: Verdana, Arial, Helvetica, sans-serif; font-size: 10pt;">
        <div>Best</div>
        <div><br></div>
        <div>Nick Kalas</div>
        <div>Manager</div>
        <div><a href="https://iron-wing-dispatching.com" target="_blank">Iron Wing Logistics L.L.C.</a></div>
        <div>phone: +1 (817) 865-3016</div>
        <div><br></div>
        <div>
            <a href="https://iron-wing-dispatching.com" target="_blank"><img src="cid:companyLogo" alt="Iron Wing Dispatching logo" width="140" height="140"></a>
        </div>
    </div>
`;

const textSignature = [
    "Best",
    "",
    "Nick Kalas",
    "Manager",
    "Iron Wing Logistics L.L.C.",
    "https://iron-wing-dispatching.com",
    "phone: +1 (817) 865-3016",
].join("\n");

export default signature;
export { textSignature };
