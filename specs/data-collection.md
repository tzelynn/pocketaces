## pocket-aces

the data gathered will help consumers make wiser decisions on which credit card to apply for and when to use what card for the best rewards

## key data needed for each credit card

- credit card name and bank and card image
- credit card min spend and max spend (eligible for each reward tier)
- expenditure reward (cashback % or mpd in terms of krisflyer miles)
    - reward block (eg in blocks of $5)
    - minimum redemption block (eg $10 for cashback, 10k miles)
    - redemption fees (if any)
- eligible transactions for the highest reward tier
    - obtain the exact mccs and transaction modes allowed or excluded
    - information should be distilled into tags such as travel (flights, hotels, airbnb, third-party booking sites like trip.com), transport (grab, simplygo), day-to-day use (food, shopping)
- any additional t&cs
- sign-up bonuses available


## additional data to be stored and referenced
- common mcc codes used by different companies and transaction types
    - to compare against the mcc allow/exclusion list for accurate tagging of eligible expenditure
- conversion rate of krisflyer miles to economy and business flights to different locations, booked at different amounts of time in advance
    - this may not be fixed, but by gathering enough data, an appropriate range with condition filters (depending on what conditions affect the conversion rate) can be set


## credit card types of interest

- most value cards in terms of cashback and/or miles per dollar spent
- cards with no min spend
- cards with no cap in rewards for big-ticket purchases (e.g. renovation, wedding)


## data scraping guidelines

- reusable scripts should be written to scrape sites such as moneysmart, singsaver and milelion for the best cards and deals
- card t&cs, especially for the mcc and transaction mode restrictions should be obtained from official bank sources as far as possible
- all sources must be cited
- all data should be stored in a standardized and organized manner
- information accuracy is very important
- since credit card terms are very dynamic, the scripts should aim to be re-usable with little to no edits as and when a data refresh is triggered

