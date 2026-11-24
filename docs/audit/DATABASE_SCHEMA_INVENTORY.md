<!-- AUDIT-2026-11-24 -->
# Database schema inventory

PostgreSQL through Prisma; not Firebase. The list is generated from prisma/schema.prisma. Prisma migrations were applied only to disposable local databases.

## Organization

Relations: None declared

Indexes and compound uniqueness: See field-level primary/unique keys

## CodeCounter

Relations: organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

Indexes and compound uniqueness: See field-level primary/unique keys

## Role

Relations: None declared

Indexes and compound uniqueness: See field-level primary/unique keys

## Permission

Relations: None declared

Indexes and compound uniqueness: See field-level primary/unique keys

## RolePermission

Relations: role         Role       @relation(fields: [roleId], references: [id], onDelete: Cascade); permission   Permission @relation(fields: [permissionId], references: [id], onDelete: Cascade)

Indexes and compound uniqueness: See field-level primary/unique keys

## User

Relations: organization      Organization @relation(fields: [organizationId], references: [id], onDelete: Restrict); role              Role         @relation(fields: [roleId], references: [id], onDelete: Restrict); primaryDepartment Department?  @relation("PrimaryDepartment", fields: [primaryDepartmentId], references: [id], onDelete: SetNull); createdBy         User?        @relation("UserCreatedBy", fields: [createdById], references: [id], onDelete: SetNull); createdUsers      User[]       @relation("UserCreatedBy"); headOfDepartments    Department[]          @relation("DepartmentHead"); managedProjects      Project[]             @relation("ProjectManager"); createdProjects      Project[]             @relation("ProjectCreatedBy"); archivedProjects     Project[]             @relation("ProjectArchivedBy"); ownedTasks           Task[]                @relation("TaskOwner"); createdTasks         Task[]                @relation("TaskCreatedBy"); taskAssignments      TaskAssignee[]        @relation("TaskAssignee"); assignedByMe         TaskAssignee[]        @relation("TaskAssignedBy"); createdItems         Item[]                @relation("ItemCreatedBy"); createdBrands        Brand[]               @relation("BrandCreatedBy"); stockTransactions    StockTransaction[]    @relation("StockTxnCreatedBy"); createdParties       Party[]               @relation("PartyCreatedBy"); reservationsCreated  StockReservation[]    @relation("ReservationCreatedBy"); attachmentsUploaded  Attachment[]          @relation("AttachmentUploadedBy"); attachmentsVerified  Attachment[]          @relation("AttachmentVerifiedBy"); requirementsCreated      MaterialRequirement[] @relation("ReqCreatedBy"); prsCreated               PurchaseRequisition[] @relation("PrCreatedBy"); prsSubmitted             PurchaseRequisition[] @relation("PrSubmittedBy"); prsApproved              PurchaseRequisition[] @relation("PrApprovedBy"); rfqsCreated              Rfq[]                 @relation("RfqCreatedBy"); rfqAwardsProposed        Rfq[]                 @relation("RfqAwardProposedBy"); rfqAwardsApproved        Rfq[]                 @relation("RfqAwardApprovedBy"); quotationsCreated        SupplierQuotation[]   @relation("SqCreatedBy"); posCreated               PurchaseOrder[]       @relation("PoCreatedBy"); posSubmitted             PurchaseOrder[]       @relation("PoSubmittedBy"); posApproved              PurchaseOrder[]       @relation("PoApprovedBy"); poRevisions              PoRevision[]          @relation("PoRevisionBy"); challansCreated          Challan[]             @relation("ChallanCreatedBy"); challansDispatched       Challan[]             @relation("ChallanDispatchedBy"); grnsCreated              Grn[]                 @relation("GrnCreatedBy"); grnsSubmitted            Grn[]                 @relation("GrnSubmittedBy"); grnsPosted               Grn[]                 @relation("GrnPostedBy"); grnsReversed             Grn[]                 @relation("GrnReversedBy"); billsCreated             SupplierBill[]        @relation("SbCreatedBy"); billsSubmitted           SupplierBill[]        @relation("SbSubmittedBy"); billsApproved            SupplierBill[]        @relation("SbApprovedBy"); paymentsCreated          Payment[]             @relation("PayCreatedBy"); paymentsCancelled        Payment[]             @relation("PayCancelledBy"); allocationsMade          PaymentAllocation[]   @relation("AllocBy"); allocationsReversed      PaymentAllocation[]   @relation("AllocReversedBy"); notesCreated             AdjustmentNote[]      @relation("NoteCreatedBy"); notesApproved            AdjustmentNote[]      @relation("NoteApprovedBy"); clientPosCreated         ClientPo[]            @relation("CpoCreatedBy"); clientPosSubmitted       ClientPo[]            @relation("CpoSubmittedBy"); clientPosApproved        ClientPo[]            @relation("CpoApprovedBy"); clientPoRevisions        ClientPoRevision[]    @relation("CpoRevisionBy"); sosCreated               SalesOrder[]          @relation("SoCreatedBy"); sosSubmitted             SalesOrder[]          @relation("SoSubmittedBy"); sosApproved              SalesOrder[]          @relation("SoApprovedBy"); soAmendmentsRequested    SoAmendmentRequest[]  @relation("SoAmendRequestedBy"); soAmendmentsDecided      SoAmendmentRequest[]  @relation("SoAmendDecidedBy"); raBillsCreated           RaBill[]              @relation("RabCreatedBy"); raBillsSubmitted         RaBill[]              @relation("RabSubmittedBy"); raBillsEngineerCertified RaBill[]              @relation("RabEngineerBy"); raBillsCertified         RaBill[]              @relation("RabCertifiedBy"); invoicesCreated          ClientInvoice[]       @relation("InvCreatedBy"); invoicesIssued           ClientInvoice[]       @relation("InvIssuedBy"); countsCreated            StockCount[]          @relation("CountCreatedBy"); countsPosted             StockCount[]          @relation("CountPostedBy"); clientQuotesCreated   ClientQuotation[]  @relation("QtCreatedBy"); clientQuotesSubmitted ClientQuotation[]  @relation("QtSubmittedBy"); clientQuotesApproved  ClientQuotation[]  @relation("QtApprovedBy"); milestonesAchieved    PaymentMilestone[] @relation("MilestoneAchievedBy")

Indexes and compound uniqueness: @@unique([organizationId, employeeCode]); @@index([organizationId, status]); @@index([organizationId, fullName])

## Session

Relations: user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)

Indexes and compound uniqueness: @@index([userId]); @@index([expiresAt])

## PasswordResetToken

Relations: user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)

Indexes and compound uniqueness: @@index([userId])

## RateLimitEvent

Relations: None declared

Indexes and compound uniqueness: @@index([key, createdAt])

## Department

Relations: organization   Organization       @relation(fields: [organizationId], references: [id], onDelete: Restrict); head           User?              @relation("DepartmentHead", fields: [headId], references: [id], onDelete: SetNull); primaryMembers User[]             @relation("PrimaryDepartment")

Indexes and compound uniqueness: @@unique([organizationId, code]); @@unique([organizationId, name]); @@index([organizationId, status])

## DepartmentMember

Relations: department   Department @relation(fields: [departmentId], references: [id], onDelete: Restrict); user         User       @relation(fields: [userId], references: [id], onDelete: Cascade)

Indexes and compound uniqueness: @@index([userId])

## Project

Relations: organization      Organization          @relation(fields: [organizationId], references: [id], onDelete: Restrict); manager           User?                 @relation("ProjectManager", fields: [managerId], references: [id], onDelete: SetNull); createdBy         User                  @relation("ProjectCreatedBy", fields: [createdById], references: [id], onDelete: Restrict); archivedBy        User?                 @relation("ProjectArchivedBy", fields: [archivedById], references: [id], onDelete: SetNull)

Indexes and compound uniqueness: @@unique([organizationId, code]); @@index([organizationId, status]); @@index([organizationId, updatedAt]); @@index([organizationId, name]); @@index([managerId])

## ProjectMember

Relations: project   Project  @relation(fields: [projectId], references: [id], onDelete: Cascade); user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)

Indexes and compound uniqueness: @@index([userId])

## ProjectStatusUpdate

Relations: project   Project  @relation(fields: [projectId], references: [id], onDelete: Restrict); author    User     @relation(fields: [authorId], references: [id], onDelete: Restrict)

Indexes and compound uniqueness: @@index([projectId, createdAt])

## Task

Relations: organization Organization     @relation(fields: [organizationId], references: [id], onDelete: Restrict); project      Project          @relation(fields: [projectId], references: [id], onDelete: Restrict); owner        User?            @relation("TaskOwner", fields: [ownerId], references: [id], onDelete: SetNull); createdBy    User             @relation("TaskCreatedBy", fields: [createdById], references: [id], onDelete: Restrict)

Indexes and compound uniqueness: @@unique([organizationId, code]); @@index([projectId]); @@index([organizationId, status]); @@index([organizationId, dueDate]); @@index([organizationId, createdAt]); @@index([organizationId, priority]); @@index([organizationId, departmentSortKey]); @@index([organizationId, assigneeSortKey]); @@index([ownerId])

## TaskDepartment

Relations: task         Task       @relation(fields: [taskId], references: [id], onDelete: Cascade); department   Department @relation(fields: [departmentId], references: [id], onDelete: Restrict)

Indexes and compound uniqueness: @@index([departmentId])

## TaskAssignee

Relations: task         Task     @relation(fields: [taskId], references: [id], onDelete: Cascade); user         User     @relation("TaskAssignee", fields: [userId], references: [id], onDelete: Restrict); assignedBy   User?    @relation("TaskAssignedBy", fields: [assignedById], references: [id], onDelete: SetNull)

Indexes and compound uniqueness: @@index([userId])

## TaskComment

Relations: task      Task     @relation(fields: [taskId], references: [id], onDelete: Cascade); author    User     @relation(fields: [authorId], references: [id], onDelete: Restrict)

Indexes and compound uniqueness: @@index([taskId, createdAt])

## TaskActivity

Relations: task      Task               @relation(fields: [taskId], references: [id], onDelete: Cascade); actor     User               @relation(fields: [actorId], references: [id], onDelete: Restrict)

Indexes and compound uniqueness: @@index([taskId, createdAt]); @@index([createdAt])

## AuditLog

Relations: organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Restrict); actor          User?        @relation(fields: [actorId], references: [id], onDelete: SetNull); project        Project?     @relation(fields: [projectId], references: [id], onDelete: SetNull)

Indexes and compound uniqueness: @@index([projectId, createdAt]); @@index([organizationId, createdAt]); @@index([entityType, entityId]); @@index([actorId])

## Notification

Relations: user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)

Indexes and compound uniqueness: @@index([userId, readAt, createdAt])

## Item

Relations: organization Organization       @relation(fields: [organizationId], references: [id], onDelete: Restrict); createdBy    User?              @relation("ItemCreatedBy", fields: [createdById], references: [id], onDelete: SetNull)

Indexes and compound uniqueness: @@unique([organizationId, code]); @@index([organizationId, status]); @@index([organizationId, name]); @@index([organizationId, category])

## ItemImage

Relations: item Item @relation(fields: [itemId], references: [id], onDelete: Cascade)

Indexes and compound uniqueness: @@unique([itemId, path]); @@index([itemId, sortOrder])

## Brand

Relations: organization Organization       @relation(fields: [organizationId], references: [id], onDelete: Restrict); createdBy    User?              @relation("BrandCreatedBy", fields: [createdById], references: [id], onDelete: SetNull)

Indexes and compound uniqueness: @@unique([organizationId, code]); @@unique([organizationId, name]); @@index([organizationId, status])

## ItemBrand

Relations: organization      Organization       @relation(fields: [organizationId], references: [id], onDelete: Restrict); item              Item               @relation(fields: [itemId], references: [id], onDelete: Restrict); brand             Brand              @relation(fields: [brandId], references: [id], onDelete: Restrict); preferredSupplier Party?             @relation("PreferredSupplier", fields: [preferredSupplierId], references: [id], onDelete: SetNull)

Indexes and compound uniqueness: @@unique([itemId, brandId]); @@index([organizationId]); @@index([brandId])

## StockTransaction

Relations: organization Organization      @relation(fields: [organizationId], references: [id], onDelete: Restrict); itemBrand    ItemBrand         @relation(fields: [itemBrandId], references: [id], onDelete: Restrict); item         Item              @relation(fields: [itemId], references: [id], onDelete: Restrict); brand        Brand             @relation(fields: [brandId], references: [id], onDelete: Restrict); location     StockLocation     @relation(fields: [locationId], references: [id], onDelete: Restrict); project      Project?          @relation(fields: [projectId], references: [id], onDelete: Restrict); createdBy    User              @relation("StockTxnCreatedBy", fields: [createdById], references: [id], onDelete: Restrict); reversalOf   StockTransaction? @relation("StockReversal", fields: [reversalOfId], references: [id], onDelete: Restrict); reversedBy   StockTransaction? @relation("StockReversal")

Indexes and compound uniqueness: @@unique([organizationId, code]); @@unique([organizationId, idempotencyKey]); @@index([itemBrandId, locationId, txnDate]); @@index([locationId, txnDate]); @@index([projectId]); @@index([itemBrandId, txnDate, createdAt]); @@index([organizationId, txnDate]); @@index([itemId]); @@index([brandId]); @@index([sourceType, sourceId])

## OrgSettings

Relations: organization               Organization  @relation(fields: [organizationId], references: [id], onDelete: Cascade)

Indexes and compound uniqueness: See field-level primary/unique keys

## DocumentSeries

Relations: organization      Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

Indexes and compound uniqueness: See field-level primary/unique keys

## DocumentCounter

Relations: organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

Indexes and compound uniqueness: See field-level primary/unique keys

## Party

Relations: organization       Organization @relation(fields: [organizationId], references: [id], onDelete: Restrict); createdBy          User?        @relation("PartyCreatedBy", fields: [createdById], references: [id], onDelete: SetNull); preferredForBrands ItemBrand[]  @relation("PreferredSupplier")

Indexes and compound uniqueness: @@unique([organizationId, code]); @@index([organizationId, name]); @@index([organizationId, isClient]); @@index([organizationId, isSupplier])

## StockLocation

Relations: organization Organization       @relation(fields: [organizationId], references: [id], onDelete: Restrict); project      Project?           @relation(fields: [projectId], references: [id], onDelete: Restrict); prsDelivery  PurchaseRequisition[] @relation("PrDeliveryLocation"); rfqsDelivery Rfq[]                 @relation("RfqDeliveryLocation"); posDelivery  PurchaseOrder[]       @relation("PoDeliveryLocation"); challansFrom Challan[]             @relation("ChallanFrom"); challansTo   Challan[]             @relation("ChallanTo"); grns         Grn[]                 @relation("GrnLocation"); counts       StockCount[]          @relation("CountLocation")

Indexes and compound uniqueness: @@unique([organizationId, code]); @@index([organizationId, type])

## StockBalance

Relations: organization Organization  @relation(fields: [organizationId], references: [id], onDelete: Restrict); itemBrand    ItemBrand     @relation(fields: [itemBrandId], references: [id], onDelete: Restrict); location     StockLocation @relation(fields: [locationId], references: [id], onDelete: Restrict)

Indexes and compound uniqueness: @@unique([itemBrandId, locationId]); @@index([locationId]); @@index([organizationId, itemId])

## StockReservation

Relations: organization Organization  @relation(fields: [organizationId], references: [id], onDelete: Restrict); project      Project       @relation(fields: [projectId], references: [id], onDelete: Restrict); itemBrand    ItemBrand     @relation(fields: [itemBrandId], references: [id], onDelete: Restrict); location     StockLocation @relation(fields: [locationId], references: [id], onDelete: Restrict); createdBy    User          @relation("ReservationCreatedBy", fields: [createdById], references: [id], onDelete: Restrict)

Indexes and compound uniqueness: @@index([itemBrandId, locationId, status]); @@index([projectId, status])

## Attachment

Relations: organization    Organization @relation(fields: [organizationId], references: [id], onDelete: Restrict); project         Project?     @relation(fields: [projectId], references: [id], onDelete: Restrict); uploadedBy      User         @relation("AttachmentUploadedBy", fields: [uploadedById], references: [id], onDelete: Restrict); verifiedBy      User?        @relation("AttachmentVerifiedBy", fields: [verifiedById], references: [id], onDelete: SetNull); previousVersion Attachment?  @relation("AttachmentVersions", fields: [previousVersionId], references: [id], onDelete: Restrict); nextVersion     Attachment?  @relation("AttachmentVersions")

Indexes and compound uniqueness: @@index([entityType, entityId]); @@index([organizationId, projectId, createdAt]); @@index([organizationId, category])

## AttachmentBlob

Relations: None declared

Indexes and compound uniqueness: See field-level primary/unique keys

## ApprovalLimit

Relations: organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

Indexes and compound uniqueness: See field-level primary/unique keys

## MaterialRequirement

Relations: organization     Organization @relation(fields: [organizationId], references: [id], onDelete: Restrict); project          Project      @relation(fields: [projectId], references: [id], onDelete: Restrict); itemBrand        ItemBrand    @relation(fields: [itemBrandId], references: [id], onDelete: Restrict); createdBy      User     @relation("ReqCreatedBy", fields: [createdById], references: [id], onDelete: Restrict); salesOrderLine SoLine?  @relation(fields: [salesOrderLineId], references: [id], onDelete: Restrict)

Indexes and compound uniqueness: @@unique([projectId, itemBrandId]); @@index([organizationId, status])

## PurchaseRequisition

Relations: organization     Organization    @relation(fields: [organizationId], references: [id], onDelete: Restrict); project          Project?        @relation(fields: [projectId], references: [id], onDelete: Restrict); deliveryLocation StockLocation?  @relation("PrDeliveryLocation", fields: [deliveryLocationId], references: [id], onDelete: Restrict); createdBy        User            @relation("PrCreatedBy", fields: [createdById], references: [id], onDelete: Restrict); submittedBy      User?           @relation("PrSubmittedBy", fields: [submittedById], references: [id], onDelete: Restrict); approvedBy       User?           @relation("PrApprovedBy", fields: [approvedById], references: [id], onDelete: Restrict)

Indexes and compound uniqueness: @@unique([organizationId, number]); @@index([organizationId, status]); @@index([projectId])

## PrLine

Relations: pr          PurchaseRequisition  @relation(fields: [prId], references: [id], onDelete: Cascade); itemBrand   ItemBrand            @relation(fields: [itemBrandId], references: [id], onDelete: Restrict); requirement MaterialRequirement? @relation(fields: [requirementId], references: [id], onDelete: SetNull)

Indexes and compound uniqueness: @@unique([prId, lineNo]); @@index([itemBrandId])

## Rfq

Relations: organization     Organization         @relation(fields: [organizationId], references: [id], onDelete: Restrict); project          Project?             @relation(fields: [projectId], references: [id], onDelete: Restrict); pr               PurchaseRequisition? @relation(fields: [prId], references: [id], onDelete: Restrict); deliveryLocation StockLocation?       @relation("RfqDeliveryLocation", fields: [deliveryLocationId], references: [id], onDelete: Restrict); createdBy        User                 @relation("RfqCreatedBy", fields: [createdById], references: [id], onDelete: Restrict); awardProposedBy  User?                @relation("RfqAwardProposedBy", fields: [awardProposedById], references: [id], onDelete: Restrict); awardApprovedBy  User?                @relation("RfqAwardApprovedBy", fields: [awardApprovedById], references: [id], onDelete: Restrict)

Indexes and compound uniqueness: @@unique([organizationId, number]); @@index([organizationId, status]); @@index([projectId])

## RfqLine

Relations: rfq            Rfq             @relation(fields: [rfqId], references: [id], onDelete: Cascade); item           Item            @relation(fields: [itemId], references: [id], onDelete: Restrict); itemBrand      ItemBrand?      @relation(fields: [itemBrandId], references: [id], onDelete: Restrict); prLine         PrLine?         @relation(fields: [prLineId], references: [id], onDelete: SetNull)

Indexes and compound uniqueness: @@unique([rfqId, lineNo])

## RfqSupplier

Relations: rfq   Rfq   @relation(fields: [rfqId], references: [id], onDelete: Cascade); party Party @relation(fields: [partyId], references: [id], onDelete: Restrict)

Indexes and compound uniqueness: @@unique([rfqId, partyId])

## SupplierQuotation

Relations: organization Organization       @relation(fields: [organizationId], references: [id], onDelete: Restrict); rfq          Rfq?               @relation(fields: [rfqId], references: [id], onDelete: Restrict); party        Party              @relation(fields: [partyId], references: [id], onDelete: Restrict); supersedes   SupplierQuotation? @relation("QuotationRevision", fields: [supersedesId], references: [id], onDelete: Restrict); supersededBy SupplierQuotation? @relation("QuotationRevision"); createdBy    User               @relation("SqCreatedBy", fields: [createdById], references: [id], onDelete: Restrict)

Indexes and compound uniqueness: @@unique([organizationId, number]); @@index([rfqId]); @@index([partyId])

## QuotationLine

Relations: quotation SupplierQuotation @relation(fields: [quotationId], references: [id], onDelete: Cascade); rfqLine   RfqLine?          @relation(fields: [rfqLineId], references: [id], onDelete: SetNull); itemBrand ItemBrand         @relation(fields: [itemBrandId], references: [id], onDelete: Restrict)

Indexes and compound uniqueness: @@index([rfqLineId])

## PurchaseOrder

Relations: organization     Organization         @relation(fields: [organizationId], references: [id], onDelete: Restrict); project          Project?             @relation(fields: [projectId], references: [id], onDelete: Restrict); party            Party                @relation(fields: [partyId], references: [id], onDelete: Restrict); deliveryLocation StockLocation        @relation("PoDeliveryLocation", fields: [deliveryLocationId], references: [id], onDelete: Restrict); rfq              Rfq?                 @relation(fields: [rfqId], references: [id], onDelete: Restrict); pr               PurchaseRequisition? @relation(fields: [prId], references: [id], onDelete: Restrict); createdBy        User                 @relation("PoCreatedBy", fields: [createdById], references: [id], onDelete: Restrict); submittedBy      User?                @relation("PoSubmittedBy", fields: [submittedById], references: [id], onDelete: Restrict); approvedBy       User?                @relation("PoApprovedBy", fields: [approvedById], references: [id], onDelete: Restrict)

Indexes and compound uniqueness: @@unique([organizationId, number]); @@index([organizationId, status]); @@index([projectId]); @@index([partyId])

## PoLine

Relations: po            PurchaseOrder      @relation(fields: [poId], references: [id], onDelete: Cascade); itemBrand     ItemBrand          @relation(fields: [itemBrandId], references: [id], onDelete: Restrict); prLine        PrLine?            @relation(fields: [prLineId], references: [id], onDelete: SetNull); quotationLine QuotationLine?     @relation(fields: [quotationLineId], references: [id], onDelete: SetNull)

Indexes and compound uniqueness: @@unique([poId, lineNo]); @@index([itemBrandId])

## PoRevision

Relations: po        PurchaseOrder @relation(fields: [poId], references: [id], onDelete: Cascade); createdBy User          @relation("PoRevisionBy", fields: [createdById], references: [id], onDelete: Restrict)

Indexes and compound uniqueness: @@unique([poId, revision])

## Challan

Relations: organization Organization   @relation(fields: [organizationId], references: [id], onDelete: Restrict); project      Project?       @relation(fields: [projectId], references: [id], onDelete: Restrict); fromLocation StockLocation? @relation("ChallanFrom", fields: [fromLocationId], references: [id], onDelete: Restrict); toLocation   StockLocation? @relation("ChallanTo", fields: [toLocationId], references: [id], onDelete: Restrict); party        Party?         @relation(fields: [partyId], references: [id], onDelete: Restrict); po           PurchaseOrder? @relation(fields: [poId], references: [id], onDelete: Restrict); so           SalesOrder?    @relation(fields: [soId], references: [id], onDelete: Restrict); createdBy    User           @relation("ChallanCreatedBy", fields: [createdById], references: [id], onDelete: Restrict); dispatchedBy User?          @relation("ChallanDispatchedBy", fields: [dispatchedById], references: [id], onDelete: Restrict)

Indexes and compound uniqueness: @@unique([organizationId, number]); @@index([organizationId, status]); @@index([projectId])

## ChallanLine

Relations: challan   Challan   @relation(fields: [challanId], references: [id], onDelete: Cascade); itemBrand ItemBrand @relation(fields: [itemBrandId], references: [id], onDelete: Restrict); poLine    PoLine?   @relation(fields: [poLineId], references: [id], onDelete: SetNull); soLine    SoLine?   @relation(fields: [soLineId], references: [id], onDelete: SetNull)

Indexes and compound uniqueness: @@unique([challanId, lineNo])

## Grn

Relations: organization Organization   @relation(fields: [organizationId], references: [id], onDelete: Restrict); project      Project?       @relation(fields: [projectId], references: [id], onDelete: Restrict); location     StockLocation  @relation("GrnLocation", fields: [locationId], references: [id], onDelete: Restrict); po           PurchaseOrder? @relation(fields: [poId], references: [id], onDelete: Restrict); challan      Challan?       @relation(fields: [challanId], references: [id], onDelete: Restrict); party        Party?         @relation(fields: [partyId], references: [id], onDelete: Restrict); createdBy    User           @relation("GrnCreatedBy", fields: [createdById], references: [id], onDelete: Restrict); submittedBy  User?          @relation("GrnSubmittedBy", fields: [submittedById], references: [id], onDelete: Restrict); postedBy     User?          @relation("GrnPostedBy", fields: [postedById], references: [id], onDelete: Restrict); reversedBy   User?          @relation("GrnReversedBy", fields: [reversedById], references: [id], onDelete: Restrict)

Indexes and compound uniqueness: @@unique([organizationId, number]); @@unique([organizationId, clientKey]); @@index([organizationId, status]); @@index([projectId]); @@index([poId])

## GrnLine

Relations: grn         Grn                @relation(fields: [grnId], references: [id], onDelete: Cascade); poLine      PoLine?            @relation(fields: [poLineId], references: [id], onDelete: Restrict); challanLine ChallanLine?       @relation(fields: [challanLineId], references: [id], onDelete: Restrict); itemBrand   ItemBrand          @relation(fields: [itemBrandId], references: [id], onDelete: Restrict)

Indexes and compound uniqueness: @@unique([grnId, lineNo]); @@index([poLineId])

## SupplierBill

Relations: organization    Organization        @relation(fields: [organizationId], references: [id], onDelete: Restrict); party           Party               @relation(fields: [partyId], references: [id], onDelete: Restrict); project         Project?            @relation(fields: [projectId], references: [id], onDelete: Restrict); po              PurchaseOrder?      @relation(fields: [poId], references: [id], onDelete: Restrict); createdBy       User                @relation("SbCreatedBy", fields: [createdById], references: [id], onDelete: Restrict); submittedBy     User?               @relation("SbSubmittedBy", fields: [submittedById], references: [id], onDelete: Restrict); approvedBy      User?               @relation("SbApprovedBy", fields: [approvedById], references: [id], onDelete: Restrict)

Indexes and compound uniqueness: @@unique([organizationId, number]); @@index([organizationId, status]); @@index([partyId, invoiceKey]); @@index([projectId]); @@index([poId])

## SupplierBillLine

Relations: bill      SupplierBill @relation(fields: [billId], references: [id], onDelete: Cascade); poLine    PoLine?      @relation(fields: [poLineId], references: [id], onDelete: Restrict); grnLine   GrnLine?     @relation(fields: [grnLineId], references: [id], onDelete: Restrict); itemBrand ItemBrand?   @relation(fields: [itemBrandId], references: [id], onDelete: Restrict)

Indexes and compound uniqueness: @@unique([billId, lineNo])

## Payment

Relations: organization Organization        @relation(fields: [organizationId], references: [id], onDelete: Restrict); party        Party               @relation(fields: [partyId], references: [id], onDelete: Restrict); project      Project?            @relation(fields: [projectId], references: [id], onDelete: Restrict); createdBy    User                @relation("PayCreatedBy", fields: [createdById], references: [id], onDelete: Restrict); cancelledBy  User?               @relation("PayCancelledBy", fields: [cancelledById], references: [id], onDelete: Restrict)

Indexes and compound uniqueness: @@unique([organizationId, number]); @@unique([organizationId, idempotencyKey]); @@index([organizationId, direction, paymentDate]); @@index([partyId]); @@index([projectId])

## PaymentAllocation

Relations: payment       Payment        @relation(fields: [paymentId], references: [id], onDelete: Restrict); supplierBill  SupplierBill?  @relation(fields: [supplierBillId], references: [id], onDelete: Restrict); clientInvoice ClientInvoice? @relation(fields: [clientInvoiceId], references: [id], onDelete: Restrict); allocatedBy   User           @relation("AllocBy", fields: [allocatedById], references: [id], onDelete: Restrict); reversedBy    User?          @relation("AllocReversedBy", fields: [reversedById], references: [id], onDelete: Restrict)

Indexes and compound uniqueness: @@index([paymentId]); @@index([supplierBillId]); @@index([clientInvoiceId])

## AdjustmentNote

Relations: organization  Organization   @relation(fields: [organizationId], references: [id], onDelete: Restrict); party         Party          @relation(fields: [partyId], references: [id], onDelete: Restrict); project       Project?       @relation(fields: [projectId], references: [id], onDelete: Restrict); supplierBill  SupplierBill?  @relation(fields: [supplierBillId], references: [id], onDelete: Restrict); clientInvoice ClientInvoice? @relation(fields: [clientInvoiceId], references: [id], onDelete: Restrict); createdBy     User           @relation("NoteCreatedBy", fields: [createdById], references: [id], onDelete: Restrict); approvedBy    User?          @relation("NoteApprovedBy", fields: [approvedById], references: [id], onDelete: Restrict)

Indexes and compound uniqueness: @@unique([organizationId, number]); @@index([partyId])

## ClientPo

Relations: organization Organization        @relation(fields: [organizationId], references: [id], onDelete: Restrict); project      Project             @relation(fields: [projectId], references: [id], onDelete: Restrict); party        Party               @relation(fields: [partyId], references: [id], onDelete: Restrict); createdBy    User                @relation("CpoCreatedBy", fields: [createdById], references: [id], onDelete: Restrict); submittedBy  User?               @relation("CpoSubmittedBy", fields: [submittedById], references: [id], onDelete: Restrict); approvedBy   User?               @relation("CpoApprovedBy", fields: [approvedById], references: [id], onDelete: Restrict)

Indexes and compound uniqueness: @@unique([organizationId, number]); @@index([organizationId, status]); @@index([projectId])

## ClientPoLine

Relations: clientPo     ClientPo      @relation(fields: [clientPoId], references: [id], onDelete: Cascade); item         Item?         @relation(fields: [itemId], references: [id], onDelete: Restrict)

Indexes and compound uniqueness: @@unique([clientPoId, lineNo])

## ClientPoRevision

Relations: clientPo  ClientPo @relation(fields: [clientPoId], references: [id], onDelete: Cascade); createdBy User     @relation("CpoRevisionBy", fields: [createdById], references: [id], onDelete: Restrict)

Indexes and compound uniqueness: @@unique([clientPoId, revision])

## ClientPoMilestone

Relations: clientPo ClientPo @relation(fields: [clientPoId], references: [id], onDelete: Cascade)

Indexes and compound uniqueness: See field-level primary/unique keys

## SalesOrder

Relations: organization      Organization         @relation(fields: [organizationId], references: [id], onDelete: Restrict); project           Project              @relation(fields: [projectId], references: [id], onDelete: Restrict); party             Party                @relation(fields: [partyId], references: [id], onDelete: Restrict); clientPo          ClientPo?            @relation(fields: [clientPoId], references: [id], onDelete: Restrict); createdBy         User                 @relation("SoCreatedBy", fields: [createdById], references: [id], onDelete: Restrict); submittedBy       User?                @relation("SoSubmittedBy", fields: [submittedById], references: [id], onDelete: Restrict); approvedBy        User?                @relation("SoApprovedBy", fields: [approvedById], references: [id], onDelete: Restrict); sourceQuotation ClientQuotation?   @relation("QtConvertedSo")

Indexes and compound uniqueness: @@unique([organizationId, number]); @@index([organizationId, status]); @@index([projectId])

## SoLine

Relations: so           SalesOrder            @relation(fields: [soId], references: [id], onDelete: Cascade); clientPoLine ClientPoLine?         @relation(fields: [clientPoLineId], references: [id], onDelete: Restrict); itemBrand    ItemBrand?            @relation(fields: [itemBrandId], references: [id], onDelete: Restrict)

Indexes and compound uniqueness: @@unique([soId, lineNo])

## SoAmendmentRequest

Relations: organization Organization @relation(fields: [organizationId], references: [id], onDelete: Restrict); so           SalesOrder   @relation(fields: [soId], references: [id], onDelete: Restrict); project      Project      @relation(fields: [projectId], references: [id], onDelete: Restrict); requestedBy  User         @relation("SoAmendRequestedBy", fields: [requestedById], references: [id], onDelete: Restrict); decidedBy    User?        @relation("SoAmendDecidedBy", fields: [decidedById], references: [id], onDelete: Restrict)

Indexes and compound uniqueness: @@unique([soId, requestNo]); @@index([organizationId, status]); @@index([projectId])

## RaBill

Relations: organization        Organization   @relation(fields: [organizationId], references: [id], onDelete: Restrict); project             Project        @relation(fields: [projectId], references: [id], onDelete: Restrict); clientPo            ClientPo       @relation(fields: [clientPoId], references: [id], onDelete: Restrict); party               Party          @relation(fields: [partyId], references: [id], onDelete: Restrict); createdBy           User           @relation("RabCreatedBy", fields: [createdById], references: [id], onDelete: Restrict); submittedBy         User?          @relation("RabSubmittedBy", fields: [submittedById], references: [id], onDelete: Restrict); engineerCertifiedBy User?          @relation("RabEngineerBy", fields: [engineerCertifiedById], references: [id], onDelete: Restrict); certifiedBy         User?          @relation("RabCertifiedBy", fields: [certifiedById], references: [id], onDelete: Restrict)

Indexes and compound uniqueness: @@unique([organizationId, number]); @@unique([clientPoId, raNumber]); @@index([organizationId, status]); @@index([projectId])

## RaBillLine

Relations: raBill       RaBill       @relation(fields: [raBillId], references: [id], onDelete: Cascade); clientPoLine ClientPoLine @relation(fields: [clientPoLineId], references: [id], onDelete: Restrict)

Indexes and compound uniqueness: @@unique([raBillId, clientPoLineId])

## ClientInvoice

Relations: organization    Organization        @relation(fields: [organizationId], references: [id], onDelete: Restrict); project         Project             @relation(fields: [projectId], references: [id], onDelete: Restrict); party           Party               @relation(fields: [partyId], references: [id], onDelete: Restrict); clientPo        ClientPo?           @relation(fields: [clientPoId], references: [id], onDelete: Restrict); raBill          RaBill?             @relation(fields: [raBillId], references: [id], onDelete: Restrict); so              SalesOrder?         @relation(fields: [soId], references: [id], onDelete: Restrict); createdBy       User                @relation("InvCreatedBy", fields: [createdById], references: [id], onDelete: Restrict); issuedBy        User?               @relation("InvIssuedBy", fields: [issuedById], references: [id], onDelete: Restrict); milestone   PaymentMilestone? @relation(fields: [milestoneId], references: [id], onDelete: Restrict)

Indexes and compound uniqueness: @@unique([organizationId, number]); @@index([organizationId, status]); @@index([projectId]); @@index([partyId])

## InvoiceLine

Relations: invoice      ClientInvoice @relation(fields: [invoiceId], references: [id], onDelete: Cascade); soLine       SoLine?       @relation(fields: [soLineId], references: [id], onDelete: Restrict); clientPoLine ClientPoLine? @relation(fields: [clientPoLineId], references: [id], onDelete: Restrict)

Indexes and compound uniqueness: @@unique([invoiceId, lineNo])

## StockCount

Relations: organization Organization     @relation(fields: [organizationId], references: [id], onDelete: Restrict); location     StockLocation    @relation("CountLocation", fields: [locationId], references: [id], onDelete: Restrict); createdBy    User             @relation("CountCreatedBy", fields: [createdById], references: [id], onDelete: Restrict); postedBy     User?            @relation("CountPostedBy", fields: [postedById], references: [id], onDelete: Restrict)

Indexes and compound uniqueness: @@unique([organizationId, number])

## StockCountLine

Relations: count     StockCount @relation(fields: [countId], references: [id], onDelete: Cascade); itemBrand ItemBrand  @relation(fields: [itemBrandId], references: [id], onDelete: Restrict)

Indexes and compound uniqueness: @@unique([countId, itemBrandId])

## ClientQuotation

Relations: organization Organization              @relation(fields: [organizationId], references: [id], onDelete: Restrict); project      Project                   @relation(fields: [projectId], references: [id], onDelete: Restrict); party        Party                     @relation(fields: [partyId], references: [id], onDelete: Restrict); createdBy    User                      @relation("QtCreatedBy", fields: [createdById], references: [id], onDelete: Restrict); submittedBy  User?                     @relation("QtSubmittedBy", fields: [submittedById], references: [id], onDelete: Restrict); approvedBy   User?                     @relation("QtApprovedBy", fields: [approvedById], references: [id], onDelete: Restrict); convertedSo  SalesOrder?               @relation("QtConvertedSo", fields: [convertedSoId], references: [id], onDelete: Restrict)

Indexes and compound uniqueness: @@unique([organizationId, number]); @@index([organizationId, status]); @@index([projectId]); @@index([partyId])

## ClientQuotationLine

Relations: quotation ClientQuotation @relation(fields: [quotationId], references: [id], onDelete: Cascade); itemBrand ItemBrand?      @relation(fields: [itemBrandId], references: [id], onDelete: Restrict)

Indexes and compound uniqueness: @@unique([quotationId, lineNo])

## ClientQuotationRevision

Relations: quotation ClientQuotation @relation(fields: [quotationId], references: [id], onDelete: Cascade)

Indexes and compound uniqueness: @@unique([quotationId, revision])

## PaymentMilestone

Relations: organization Organization     @relation(fields: [organizationId], references: [id], onDelete: Restrict); quotation    ClientQuotation? @relation(fields: [quotationId], references: [id], onDelete: Cascade); so           SalesOrder?      @relation(fields: [soId], references: [id], onDelete: Cascade); achievedBy   User?            @relation("MilestoneAchievedBy", fields: [achievedById], references: [id], onDelete: SetNull)

Indexes and compound uniqueness: @@index([quotationId]); @@index([soId])

## PaymentTermTemplate

Relations: organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

Indexes and compound uniqueness: @@unique([organizationId, name])

